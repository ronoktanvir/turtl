import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Facts } from "./runner/handlers/journey";

declare const process: { env: Record<string, string | undefined> };

// One model call that turns the facts and evidence into a cause in plain language. When no model
// answers, a deterministic reading of the facts is used and labelled as such: it is never presented
// as a model's diagnosis.

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const MODEL_ENV = "DIAGNOSIS_MODEL";
export const HARNESS_VERSION = "turtl-diagnosis-v1";
export const PROMPT_VERSION = "diagnosis-prompt-v1";
const MODEL_TIMEOUT_MS = 30_000;

export const modelId = () => process.env[MODEL_ENV] || DEFAULT_MODEL;

const SYSTEM_PROMPT = [
  "You diagnose an outage in a small booking app for its owner, who is not an engineer.",
  "Use only the facts and evidence you are given. Do not invent causes they do not support.",
  'Reply with a JSON object: {"cause": string, "confidence": number, "supportingEvidenceIds": string[]}.',
  "cause: at most two plain sentences saying why customers cannot book.",
  "confidence: from 0 to 1, how strongly the evidence supports that cause.",
  "supportingEvidenceIds: ids from the evidence list that support it.",
  "If the evidence does not establish a cause, say so and give a low confidence.",
].join("\n");

export type EvidenceSummary = { id: string; kind: string; title: string; body?: string };

export type Reading = { cause: string; confidence: number; supportingEvidenceIds: string[] };

export async function askModel(
  facts: Facts,
  evidence: EvidenceSummary[],
): Promise<{ ok: true; reading: Reading } | { ok: false; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "OPENAI_API_KEY is not set on this deployment, so no request was sent" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId(),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ facts, evidence }) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `the model call returned HTTP ${response.status}` };
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "null") as Partial<Reading> | null;
    if (!parsed || typeof parsed.cause !== "string" || !parsed.cause.trim()) {
      return { ok: false, reason: "the model's answer had no cause" };
    }
    const known = new Set(evidence.map((e) => e.id));
    const confidence = Number(parsed.confidence);
    return {
      ok: true,
      reading: {
        cause: parsed.cause.trim(),
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        supportingEvidenceIds: (parsed.supportingEvidenceIds ?? []).filter((id) => known.has(id)),
      },
    };
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

// The deterministic fallback: fixed rules over the facts. Its confidence is capped low on purpose.
export function ruleReading(facts: Facts, evidence: EvidenceSummary[]): Reading {
  const byKind = (kinds: string[]) => evidence.filter((e) => kinds.includes(e.kind)).map((e) => e.id);
  if (facts["journey.verdict"] === "passed") {
    return {
      cause: "The booking check passes now, so these facts show no current failure to explain.",
      confidence: 0.2,
      supportingEvidenceIds: byKind(["journey_check"]),
    };
  }
  if (
    facts["journey.failedStep"] === "recommendations" &&
    facts["journey.errorCode"] === "RECOMMENDATIONS_TIMEOUT" &&
    facts["flags.recommendationsEnabled"] === true
  ) {
    return {
      cause:
        "Booking waits for service recommendations while they are turned on, and the recommendations provider is timing out, so bookings never get saved.",
      confidence: 0.5,
      supportingEvidenceIds: byKind(["journey_check", "flags", "errors"]),
    };
  }
  const step = facts["journey.failedStep"] ?? "unknown";
  const code = facts["journey.errorCode"] ?? "unknown";
  return {
    cause: `The booking check fails at the "${step}" step with ${code}. No rule matches this, so the cause is unknown.`,
    confidence: 0.1,
    supportingEvidenceIds: byKind(["journey_check"]),
  };
}

export const startRun = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    modelId: v.string(),
  },
  handler: async (ctx, { caseId, stepId, stepAttemptId, modelId }) => {
    const attempt = await ctx.db.get(stepAttemptId);
    if (!attempt || attempt.caseId !== caseId || attempt.stepId !== stepId) {
      throw new Error("The step attempt does not belong to this case.");
    }
    return await ctx.db.insert("agentRuns", {
      caseId,
      stepId,
      stepAttemptId,
      taskType: "diagnose_outage",
      config: {
        modelId,
        harnessVersion: HARNESS_VERSION,
        promptVersion: PROMPT_VERSION,
        credentialRef: "OPENAI_API_KEY",
      },
      taskCharacteristics: {
        complexity: "one failing journey",
        risk: "customer-facing outage",
        framework: "Expo and Convex",
        repositoryArea: "not inspected",
      },
      contextRefs: [],
      routingReason: "Fixed: the only diagnosis configuration. No routing between configurations yet.",
      status: "running",
      corrections: [],
    });
  },
});

export const finishRun = internalMutation({
  args: {
    agentRunId: v.id("agentRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    durationMs: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { agentRunId, ...fields }) => {
    const run = await ctx.db.get(agentRunId);
    if (!run || run.status !== "running") throw new Error("This agent run is not running.");
    await ctx.db.patch(agentRunId, fields);
  },
});
