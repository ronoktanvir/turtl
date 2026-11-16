import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { gateFor } from "../consent/gate";
import type { Criterion, OptionKind, ProposalOption, Stage } from "../constants";
import { askJson, fixesModelId, keyFor, MAX_FIXES, orderFixes, pullRequestEntry, pullRequestOption, type CodeChangeDraft } from "../fixOptions";
import { CRITERIA, revisionOf } from "../protectedApp/client";
import type { HandlerInput, StepHandler } from "../runner/contract";
import { evidenceRow, factsOf, type CaseContext, type Facts } from "../runner/handlers/journey";
import { BUG_PROMPT, FEATURE_PROMPT, HARNESS_VERSION, OPTIONS_PROMPT } from "./rules";

// The investigate and plan steps for cases customers raised. Every other case keeps the registered handler.

const MAX_REPORTS_IN_PROMPT = 10;
export const INVESTIGATE_PROMPT_VERSION = "intake-investigate-v1";
export const OPTIONS_PROMPT_VERSION = "intake-options-v1";

export const isCustomerCase = (row: Doc<"cases">) =>
  row.raisedBy === "customer" && (row.kind === "bug_report" || row.kind === "feature_request");

// "The requested change is in the app" for a feature; the server checks only show nothing else broke.
export const FEATURE_BUILT: Criterion = {
  id: "requested_change_present",
  description: "The requested change is in the app, shown by before and after screenshots.",
};
const doneMeansFor = (row: Doc<"cases">): Criterion[] =>
  row.kind === "feature_request" ? [FEATURE_BUILT, CRITERIA.health, CRITERIA.journey] : [CRITERIA.health, CRITERIA.journey, CRITERIA.device];

export const startRun = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    taskType: v.string(),
    promptVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.stepAttemptId);
    if (!attempt || attempt.caseId !== args.caseId || attempt.stepId !== args.stepId) {
      throw new Error("The step attempt does not belong to this case.");
    }
    return await ctx.db.insert("agentRuns", {
      caseId: args.caseId,
      stepId: args.stepId,
      stepAttemptId: args.stepAttemptId,
      taskType: args.taskType,
      config: { modelId: fixesModelId(), harnessVersion: HARNESS_VERSION, promptVersion: args.promptVersion, credentialRef: "OPENAI_API_KEY" },
      taskCharacteristics: {
        complexity: "customer reports with the app's fresh checks",
        risk: "untrusted customer text",
        framework: "Expo and Convex",
        repositoryArea: "not inspected",
      },
      contextRefs: [],
      routingReason: "Fixed: the only configuration for customer reports. No routing between configurations yet.",
      status: "running",
      corrections: [],
    });
  },
});

export const finishRun = internalMutation({
  args: { agentRunId: v.id("agentRuns"), status: v.union(v.literal("completed"), v.literal("failed")), durationMs: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, { agentRunId, ...fields }) => {
    const run = await ctx.db.get(agentRunId);
    if (!run || run.status !== "running") throw new Error("This agent run is not running.");
    await ctx.db.patch(agentRunId, fields);
  },
});

// One model call with its agentRuns row; a missing key or failed call comes back as a reason.
async function askWithRun(
  ctx: Parameters<StepHandler["run"]>[0],
  input: HandlerInput,
  taskType: string,
  promptVersion: string,
  system: string,
  user: unknown,
) {
  const agentRunId: Id<"agentRuns"> = await ctx.runMutation(internal.intake.workflow.startRun, {
    caseId: input.case._id,
    stepId: input.step._id,
    stepAttemptId: input.attempt._id,
    taskType,
    promptVersion,
  });
  const started = Date.now();
  // A case customers opened is read on the project's customer-report allowance, so customers cannot spend the
  // owner's; when it runs out for the day, the labelled rule-based reading below stands in.
  const answer = await askJson(gateFor(ctx, { appId: input.case.appId }, "intake"), system, user);
  await ctx.runMutation(internal.intake.workflow.finishRun, {
    agentRunId,
    status: answer.ok ? "completed" : "failed",
    durationMs: Date.now() - started,
    ...(!answer.ok && { error: `No model answered: ${answer.reason}.` }),
  });
  return { agentRunId, answer };
}

const text = (value: unknown, max = 600) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.3);

async function load(ctx: Parameters<StepHandler["run"]>[0], input: HandlerInput) {
  const context: CaseContext = await ctx.runQuery(internal.protectedApp.records.caseContext, { caseId: input.case._id });
  const reports: { _id: Id<"reports">; text: string }[] = await ctx.runQuery(internal.intake.records.caseReports, { caseId: input.case._id });
  const facts: Facts | null = factsOf(context);
  const base = context.app?.productionUrl ?? "https://app.invalid";
  const revision = revisionOf(typeof facts?.["app.revision"] === "string" ? facts["app.revision"] : null, base);
  return { context, reports, facts, revision, prompted: reports.slice(-MAX_REPORTS_IN_PROMPT).map((r) => r.text.slice(0, 600)) };
}



// investigate for a customer case: one model call over the reports and the fresh checks; a labelled rule-based reading otherwise.
export const investigateReport: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input) => {
    const { context, reports, facts, revision, prompted } = await load(ctx, input);
    if (!reports.length) return { status: "failed", error: "No customer report is attached to this case." };
    const feature = input.case.kind === "feature_request";
    const gatheredFrom = context.steps.find((s) => s.purpose === "gather_context")?.currentAttemptId;
    const gathered = context.evidence
      .filter((e) => e.stepAttemptId === gatheredFrom || e.kind === "journey_check")
      .map((e) => ({ id: e._id, kind: e.kind, title: e.title }));
    const { agentRunId, answer } = await askWithRun(
      ctx,
      input,
      feature ? "read_feature_request" : "diagnose_customer_report",
      INVESTIGATE_PROMPT_VERSION,
      feature ? FEATURE_PROMPT : BUG_PROMPT,
      { app: context.app?.name ?? "the app", reportCount: reports.length, reports: prompted, ...(!feature && { facts, evidence: gathered }) },
    );
    const known = new Set(gathered.map((e) => e.id as string));
    const read = answer.ok ? text(feature ? answer.json.request : answer.json.cause) : "";
    const noModel = answer.ok ? (read ? null : "the model's answer had no reading") : answer.reason;
    const first = reports[0].text.replace(/\s+/g, " ").slice(0, 160);
    const verdict = typeof facts?.["journey.verdict"] === "string" ? facts["journey.verdict"] : null;
    const cause = read || (feature
      ? `${reports.length} customer request${reports.length === 1 ? "" : "s"}, the first in their words: "${first}".`
      : `${reports.length} customer report${reports.length === 1 ? "" : "s"}, the first in their words: "${first}". ${verdict ? `turtl's booking check ${verdict === "passed" ? "passes now, so it does not reproduce this" : "fails now"}.` : "No check of the app covers this."}`);
    const confidence = read ? clamp(answer.ok ? answer.json.confidence : 0) : 0.2;
    const supportingEvidenceIds = read && answer.ok && Array.isArray(answer.json.supportingEvidenceIds)
      ? (answer.json.supportingEvidenceIds as unknown[]).filter((id): id is Id<"evidence"> => typeof id === "string" && known.has(id))
      : [];
    const model = fixesModelId();
    const percent = Math.round(confidence * 100);
    const [evidenceId]: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, {
      rows: [
        evidenceRow(input, revision, {
          kind: "diagnosis",
          title: read
            ? `${feature ? "What customers ask for" : "Likely cause"}, from ${model} (confidence ${percent}%)`
            : `Rule-based reading, not a model's ${feature ? "reading" : "diagnosis"} (confidence ${percent}%)`,
          body: noModel ? `${cause}\n\nNo model answered: ${noModel}.` : cause,
          sourceRef: read ? `agentRuns/${agentRunId}` : "rule-based reading of the reports",
        }),
      ],
    });
    return {
      status: "done",
      summary: read ? `${feature ? "What customers ask for" : "Likely cause"} (${model}, confidence ${percent}%): ${cause}` : `No model answered: ${noModel}. A rule-based reading says: ${cause}`,
      handoff: {
        note: read ? "A model's reading of the customer reports is in this attempt's output." : "No model answered; a rule-based reading is in this attempt's output.",
        refs: [
          { kind: "evidence", id: evidenceId, label: "diagnosis" },
          { kind: "agentRun", id: agentRunId },
        ],
      },
      output: {
        diagnosis: {
          source: read ? "model" : "rules",
          cause,
          confidence,
          supportingEvidenceIds,
          supportingFactKeys: [],
          modelId: read ? model : null,
          noModelReason: noModel,
          ...(!feature && answer.ok && { reproduced: answer.json.reproduced === true }),
        },
        agentRunId,
        evidenceId,
      },
    };
  },
};



// Reads one option the model wrote; null when a field is missing. The kind comes from the case, not the model, for a feature.
function readOption(raw: unknown, feature: boolean): (CodeChangeDraft & { recommended: boolean }) | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind: OptionKind = feature ? "change" : o.kind === "prevention" ? "prevention" : "repair";
  const draft = {
    title: text(o.title, 80),
    kind,
    why: text(o.why),
    whatChanges: text(o.whatChanges),
    whatMightBeLost: text(o.whatMightBeLost),
    howChecked: text(o.howChecked),
    change: text(o.change, 2000),
    confidence: clamp(o.confidence),
    recommended: o.recommended === true,
  };
  return draft.title && draft.why && draft.whatChanges && draft.whatMightBeLost && draft.howChecked && draft.change ? draft : null;
}

// plan for a customer case: one to four code changes ("Build it" for a feature) bound to the app's pull request action.
// A bug report whose fresh booking check fails is an outage in customers' words, so it keeps the registered plan.
export function planReport(outagePlan: StepHandler): StepHandler {
  return {
    timeoutMs: Math.max(outagePlan.timeoutMs, 60_000),
    run: async (ctx, input) => {
      const { context, reports, facts, prompted } = await load(ctx, input);
      const feature = input.case.kind === "feature_request";
      if (!feature && facts?.["journey.verdict"] === "failed") return await outagePlan.run(ctx, input);
      if (!context.journey) {
        return { status: "done", summary: "Placeholder: this app has no journey, so no option was planned.", handoff: { note: "No plan to pass on.", refs: [] } };
      }
      const entry = pullRequestEntry(context.catalog);
      if (!entry) {
        return { status: "failed", error: "This app has no pull request action in its catalog, so no code change can be offered or approved yet." };
      }
      const investigation = context.steps.find((s) => s.purpose === "investigate")?.currentAttempt?.output as
        | { diagnosis?: { cause?: string }; evidenceId?: Id<"evidence"> }
        | undefined;
      const { agentRunId, answer } = await askWithRun(
        ctx,
        input,
        feature ? "propose_feature_options" : "propose_customer_bug_fixes",
        OPTIONS_PROMPT_VERSION,
        OPTIONS_PROMPT(feature, MAX_FIXES),
        {
          app: context.app?.name ?? "the app",
          repository: entry.config.kind === "capy" ? entry.config.repoUrl : null,
          understanding: investigation?.diagnosis?.cause ?? null,
          reportCount: reports.length,
          reports: prompted,
          ...(!feature && { facts }),
        },
      );
      if (!answer.ok) {
        return { status: "failed", error: `No options were offered: no model answered (${answer.reason}). turtl does not write a code change without one.` };
      }
      const raws = Array.isArray(answer.json.options) ? answer.json.options : [];
      const people = input.case.distinctRequesterCount ?? reports.length;
      const basis = {
        journey: context.journey,
        doneMeans: doneMeansFor(input.case),
        evidenceIds: investigation?.evidenceId ? [investigation.evidenceId] : [],
        ...(!feature && { usersCantNow: `${people} customer${people === 1 ? "" : "s"} reported this.` }),
      };
      const options: ProposalOption[] = [];
      const flagged: string[] = [];
      for (const raw of raws) {
        const draft = readOption(raw, feature);
        if (!draft || options.length >= MAX_FIXES) continue;
        const key = keyFor(draft.title, options.map((o) => o.key));
        try {
          options.push(pullRequestOption(entry, draft, basis, key));
          if (draft.recommended) flagged.push(key);
        } catch {
          continue;
        }
      }
      if (!options.length) return { status: "failed", error: "The model offered no complete option, so nothing was proposed." };
      const pick = flagged[0] ?? options.reduce((best, o) => (o.confidence > best.confidence ? o : best)).key;
      for (const option of options) option.recommended = option.key === pick;
      const proposalId: Id<"proposals"> = await ctx.runMutation(internal.protectedApp.records.writeProposal, {
        caseId: input.case._id,
        stepId: input.step._id,
        doneMeans: basis.doneMeans,
        options: orderFixes(options),
      });
      const dropped = raws.length - options.length;
      return {
        status: "done",
        summary: `${options.length} ${feature ? "option" : "code change"}${options.length === 1 ? "" : "s"} offered (${fixesModelId()}), each a pull request the owner approves and merges.${dropped > 0 ? ` ${dropped} suggestion(s) were incomplete or over the limit of ${MAX_FIXES}.` : ""} Waiting for the owner's decision.`,
        handoff: {
          note: "Proposal version 1 is ready for the owner.",
          refs: [
            { kind: "proposal", id: proposalId, label: "v1" },
            { kind: "agentRun", id: agentRunId },
          ],
        },
        output: { proposalId, matchedMemoryId: null },
      };
    },
  };
}

const route = (registered: StepHandler, customer: StepHandler): StepHandler => ({
  timeoutMs: Math.max(registered.timeoutMs, customer.timeoutMs),
  run: (ctx, input) => (isCustomerCase(input.case) ? customer.run(ctx, input) : registered.run(ctx, input)),
});

// Wraps the registered handlers so customer bug reports and feature requests get their own investigate and plan.
export const withCustomerReports = (handlers: Record<Stage, StepHandler>): Record<Stage, StepHandler> => ({
  ...handlers,
  investigate: route(handlers.investigate, investigateReport),
  plan: route(handlers.plan, planReport(handlers.plan)),
});
