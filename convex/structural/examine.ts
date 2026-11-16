import { NO_MODEL_REASON } from "../constants";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { gateFor, type Gate } from "../consent/gate";
import { ASSUMED_OUTPUT_TOKENS, callEstimate, modelCost } from "../spend/limits";
import type { HandlerInput, HandlerResult } from "../runner/contract";
import { readFinding, type KnownRecord, type ScenarioId } from "./rules";

declare const process: { env: Record<string, string | undefined> };

// The examine_broader_causes step. It asks one model, rarely, whether this case and its related history point
// to one deeper cause. It never fails the step: whatever happens, the case continues to plan, approval and
// verification, and the summary says what actually happened.

export const MODEL_ENV = "STRUCTURAL_MODEL";
export const MODEL_TIMEOUT_MS = 45_000;
export const STEP_TIMEOUT_MS = 90_000;

// A stronger default than diagnosis: this call is rare, and in offline trials on the booking demo's history
// gpt-5.4-mini stated the disproving outcome backwards in 6 of 6 replies, gpt-5.4 in 0 of 3.
export const DEFAULT_MODEL = "gpt-5.4";
export const structuralModelId = () => process.env[MODEL_ENV] || DEFAULT_MODEL;

const SYSTEM_PROMPT = [
  "You are turtl's big-picture reviewer for a small app whose owner is not an engineer. Several incidents on this app are related. Decide whether the current symptom reflects one deeper, structural problem in how the app is built, rather than separate one-off failures.",
  "Use only the records you are given: the current case, the related cases with their recorded causes, actions and verification outcomes, and the code map when there is one. Never invent records, files or causes they do not support. A recovery that worked before is not, by itself, evidence of a structural cause.",
  'Reply with a JSON object: {"finding": Finding | null, "note": string}.',
  'Finding is {"hypothesis": string, "evidence": [{"ref": string, "says": string}], "change": {"title": string, "kind": "repair" | "prevention", "whatChanges": string, "whatMightBeLost": string, "scope": string[], "change": string}, "test": {"description": string, "expectedIfTrue": string, "disprovedIf": string, "scenario": string | null}, "confidence": number}.',
  "hypothesis: one or two plain sentences naming the one structural cause that connects these cases: the part of the app, and the coupling or design flaw.",
  "evidence: at least two items, from at least two different cases. ref is an exact id copied from the records. Cite the most specific record that shows the point: an evidence, verification, action, recovery memory or code node id; use a case id only when no more specific record shows it. says is what that record shows, in plain words.",
  "change: one bounded change that removes the structural cause or stops it reaching customers. Never a rewrite. title: at most 8 words. kind: repair when it removes the cause, prevention when it adds a guard. scope: at most three files or areas it touches. change: precise instructions for the engineer writing the pull request, at most 1,200 characters. whatChanges and whatMightBeLost: plain words for the owner.",
  "test: a test that could show the hypothesis is wrong, run against the app as it is now, before any change. description: what to run. expectedIfTrue: what that run shows now if the hypothesis is right. disprovedIf: what that run shows now if the hypothesis is wrong; it must contradict expectedIfTrue. Example, for the hypothesis 'saving a booking waits on an optional call': expectedIfTrue 'no booking is saved while the optional call is slow', disprovedIf 'a booking is still saved while the optional call is slow'. This is a test of the hypothesis, not of the change. scenario: the id of one of availableChecks when running that check is this test, otherwise null.",
  "confidence: from 0 to 1, how strongly the records support the hypothesis.",
  "If the records do not support a structural cause, set finding to null and say why in note.",
].join("\n");

type Answer = { ok: true; json: Record<string, unknown> } | { ok: false; reason: string };

async function ask(gate: Gate, prompt: unknown): Promise<Answer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: NO_MODEL_REASON };
  const model = structuralModelId();
  const opened = await gate.open("openai", "send", callEstimate(model, SYSTEM_PROMPT.length + JSON.stringify(prompt).length));
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await opened.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_completion_tokens: ASSUMED_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(prompt) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `the model call returned HTTP ${response.status}` };
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    await gate.spent(modelCost(model, body.usage && { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 }));
    const json = JSON.parse(body.choices?.[0]?.message?.content ?? "null") as unknown;
    if (!json || typeof json !== "object") return { ok: false, reason: "the model's answer was not a JSON object" };
    return { ok: true, json: json as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `the model did not answer within ${MODEL_TIMEOUT_MS / 1000} s`
        : `the model call failed (${error instanceof Error ? error.name : "unknown error"})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const done = (summary: string, output: Record<string, unknown>, refs: { kind: string; id: string; label?: string }[] = []): HandlerResult => ({
  status: "done",
  summary,
  handoff: { note: summary, refs },
  output,
});

export async function examineBroaderCauses(ctx: ActionCtx, input: HandlerInput): Promise<HandlerResult> {
  try {
    const context = await ctx.runQuery(internal.structural.records.examineContext, { caseId: input.case._id });
    if (context.skip !== null) {
      return done(context.skip, { examined: false, relatedCaseIds: context.relatedCaseIds });
    }
    const { prompt, known } = context;
    const related = context.relatedCaseIds.length;
    const model = structuralModelId();
    const started = Date.now();
    const agentRunId: Id<"agentRuns"> = await ctx.runMutation(internal.structural.records.startRun, {
      caseId: input.case._id,
      stepId: input.step._id,
      stepAttemptId: input.attempt._id,
      modelId: model,
      relatedCaseCount: related,
      hasCodeMap: !!prompt.codeMap,
      reason: context.reason === "recurrence" ? "the failure came back after a verified recovery" : `the case has ${related} related cases`,
    });
    // A case customers raised is examined on the project's customer-report allowance, like the rest of its reading
    // (convex/intake/workflow.ts), so what customers post cannot spend the owner's own allowance.
    const answer = await ask(gateFor(ctx, { appId: input.case.appId }, input.case.raisedBy === "customer" ? "intake" : "account"), prompt);
    const runRef = { kind: "agentRun", id: agentRunId };
    const examined = `Examined ${related} related case${related === 1 ? "" : "s"} (${context.triggerSummary.replace(/\.$/, "")}).`;
    if (!answer.ok) {
      await ctx.runMutation(internal.structural.records.finishRun, {
        agentRunId,
        status: "failed",
        durationMs: Date.now() - started,
        error: `No model answered: ${answer.reason}.`,
      });
      return done(
        `${examined} No model answered (${answer.reason}), so no broader cause was recorded. The case continues.`,
        { examined: true, relatedCaseIds: context.relatedCaseIds, agentRunId, finding: null, noModelReason: answer.reason },
        [runRef],
      );
    }
    await ctx.runMutation(internal.structural.records.finishRun, { agentRunId, status: "completed", durationMs: Date.now() - started });
    const note = typeof answer.json.note === "string" ? answer.json.note.trim() : "";
    if (!answer.json.finding) {
      return done(
        `${examined} ${model} found no structural cause${note ? `: ${note}` : "."}`,
        { examined: true, relatedCaseIds: context.relatedCaseIds, agentRunId, finding: null, note },
        [runRef],
      );
    }
    const scenarios = prompt.availableChecks.map((c: { id: ScenarioId }) => c.id);
    const read = readFinding(answer.json.finding, new Map(Object.entries(known as Record<string, KnownRecord>)), scenarios);
    if (!read.ok) {
      return done(
        `${examined} ${model} described a broader cause, but its reply had no ${read.missing.join(", no ")}. It is kept as a note on this step and is not offered to you.`,
        { examined: true, relatedCaseIds: context.relatedCaseIds, agentRunId, finding: null, incomplete: { missing: read.missing, reply: answer.json.finding, note } },
        [runRef],
      );
    }
    const findingId: Id<"structuralFindings"> = await ctx.runMutation(internal.structural.records.recordFinding, {
      caseId: input.case._id,
      stepAttemptId: input.attempt._id,
      agentRunId,
      hypothesis: read.hypothesis,
      evidence: read.evidence,
      change: read.change,
      test: read.test,
      confidence: read.confidence,
      connectedCaseIds: read.connectedCaseIds.filter((id) => id !== input.case._id) as Id<"cases">[],
      seededCaseCount: context.seededCaseCount,
    });
    const percent = Math.round(read.confidence * 100);
    const seeded = context.seededCaseCount ? ` ${context.seededCaseCount} of the related cases are seeded samples, not real incidents.` : "";
    return done(
      `${examined} Likely deeper cause (${model}, confidence ${percent}%): ${read.hypothesis} turtl offers "${read.change.title}" as a fix${read.test.scenario ? " and a prevention check" : ""}.${seeded}`,
      { examined: true, relatedCaseIds: context.relatedCaseIds, agentRunId, findingId },
      [runRef, { kind: "structuralFinding", id: findingId }],
    );
  } catch (error) {
    console.error("examine_broader_causes failed", error);
    return done(
      "Broader causes could not be examined, because something went wrong while turtl looked. No finding was recorded; the case continues.",
      { examined: false, error: true },
    );
  }
}
