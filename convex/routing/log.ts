import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, type MutationCtx } from "../_generated/server";
import { requireOwnerPasscode } from "../ownerPasscode";
import { ROUTING_POLICY_VERSION } from "./configs";
import { bucketOf, type LogEntry } from "./selector";
import { vOutcome, vRouting } from "./validators";

// The agent performance log: every model run's configuration, task traits, cost, duration and outcome, in agentRuns.

export const DIAGNOSIS_TASK = "diagnose_outage";

export const startRun = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    taskType: v.string(),
    config: v.object({
      modelId: v.string(),
      reasoning: v.optional(v.string()),
      harnessVersion: v.string(),
      promptVersion: v.string(),
      credentialRef: v.string(),
    }),
    taskCharacteristics: v.object({
      complexity: v.string(),
      risk: v.string(),
      framework: v.string(),
      repositoryArea: v.string(),
    }),
    routingReason: v.string(),
    routing: vRouting,
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.stepAttemptId);
    if (!attempt || attempt.caseId !== args.caseId || attempt.stepId !== args.stepId) {
      throw new Error("The step attempt does not belong to this case.");
    }
    const row = await ctx.db.get(args.caseId);
    if (!row) throw new Error("The case does not exist.");
    return await ctx.db.insert("agentRuns", {
      ...args,
      appId: row.appId,
      contextRefs: [],
      routingPolicyVersion: ROUTING_POLICY_VERSION,
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
    costUsd: v.optional(v.number()),
    usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number() })),
    outcome: v.optional(vOutcome),
    outcomeReason: v.optional(v.string()),
  },
  handler: async (ctx, { agentRunId, ...fields }) => {
    const run = await ctx.db.get(agentRunId);
    if (!run || run.status !== "running") throw new Error("This agent run is not running.");
    await ctx.db.patch(agentRunId, { ...fields, ...(fields.outcome && { outcomeAt: Date.now() }) });
  },
});

// The handoff: a run that could not establish a cause passes its evidence and reading to a new, stronger run. The
// first run is logged as failed for routing, because it did not establish the cause.
export const handUp = internalMutation({
  args: { fromRunId: v.id("agentRuns"), toRunId: v.id("agentRuns"), handoff: v.string() },
  handler: async (ctx, { fromRunId, toRunId, handoff }) => {
    const from = await ctx.db.get(fromRunId);
    const to = await ctx.db.get(toRunId);
    if (!from?.routing || !to?.routing || from.caseId !== to.caseId) throw new Error("These runs cannot be linked.");
    await ctx.db.patch(fromRunId, {
      routing: { ...from.routing, escalatedToRunId: toRunId, handoff },
      outcome: "failed",
      outcomeReason: `Handed up: ${handoff}`,
      outcomeAt: Date.now(),
    });
    await ctx.db.patch(toRunId, { routing: { ...to.routing, escalatedFromRunId: fromRunId, handoff } });
  },
});

export const linkCouncil = internalMutation({
  args: { agentRunId: v.id("agentRuns"), councilReviewId: v.id("councilReviews") },
  handler: async (ctx, { agentRunId, councilReviewId }) => {
    const run = await ctx.db.get(agentRunId);
    if (!run?.routing) return;
    await ctx.db.patch(agentRunId, { routing: { ...run.routing, councilReviewId } });
  },
});

// What the selector reads: settled outcomes for one task type, newest first, plus which failures were verified before.
// Buckets are recomputed from each run's stored traits, so a change to the bucketing policy re-buckets old outcomes too.
export const history = internalQuery({
  args: { taskType: v.string() },
  handler: async (ctx, { taskType }): Promise<{ log: LogEntry[]; verifiedFailures: string[] }> => {
    const rows = await ctx.db
      .query("agentRuns")
      .withIndex("by_task_and_settled", (q) => q.eq("taskType", taskType).gt("outcomeAt", 0))
      .order("desc")
      .take(500);
    const log: LogEntry[] = [];
    const verifiedFailures = new Set<string>();
    for (const row of rows) {
      if (!row.outcome || !row.routing?.traits) continue;
      log.push({ configKey: row.routing.configKey, bucket: bucketOf(row.routing.traits), outcome: row.outcome });
      if (row.outcome === "verified" && row.routing.traits) verifiedFailures.add(row.routing.traits.failure);
    }
    return { log, verifiedFailures: [...verifiedFailures].sort() };
  },
});

export const caseSpend = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const runs = await ctx.db.query("agentRuns").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
    let diagnosis = 0;
    let council = 0;
    for (const run of runs) {
      if (run.taskType === DIAGNOSIS_TASK) diagnosis += run.costUsd ?? 0;
      else if (run.taskType.startsWith("council_")) council += run.costUsd ?? 0;
    }
    return { diagnosis, council };
  },
});

type CaseVerdict = { outcome?: Doc<"agentRuns">["outcome"]; reason: string } | null;

// The case's result as far as routing is concerned, or null while it is still open. A declined fix is not counted:
// the owner's choice says nothing about whether the diagnosis was right.
async function caseVerdict(ctx: MutationCtx, caseId: Id<"cases">): Promise<CaseVerdict> {
  const row = await ctx.db.get(caseId);
  if (!row) return null;
  const verifications = await ctx.db.query("verifications").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
  const after = verifications.filter((item) => item.phase !== "before").sort((a, b) => b.completedAt - a.completedAt)[0];
  if (after?.verdict === "passed") {
    return { outcome: "verified", reason: `The fix based on this diagnosis passed verification (${after.summary})` };
  }
  if (row.status === "declined") return { reason: "Not counted: the owner declined the fix, which says nothing about the diagnosis." };
  if (row.status === "unresolved" || (after?.verdict === "failed" && (row.status === "resolved" || row.status === "restored"))) {
    return { outcome: "failed", reason: after ? `Verification after the fix failed (${after.summary})` : "The case ended unresolved." };
  }
  if (row.status === "resolved") return { reason: "Not counted: the case closed without a verification after a fix." };
  return null;
}

export async function settleCase(ctx: MutationCtx, caseId: Id<"cases">) {
  const verdict = await caseVerdict(ctx, caseId);
  if (!verdict) return 0;
  const runs = await ctx.db.query("agentRuns").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
  let settled = 0;
  for (const run of runs) {
    if (run.outcomeAt !== undefined || run.status === "running" || run.status === "queued") continue;
    if (run.taskType !== DIAGNOSIS_TASK) {
      await ctx.db.patch(run._id, {
        outcomeReason: run.taskType.startsWith("council_")
          ? "Not scored: a council answer is an input to the proposal, not a diagnosis a fix tests."
          : "Not scored: only diagnosis runs are scored for routing.",
        outcomeAt: Date.now(),
      });
      continue;
    }
    await ctx.db.patch(run._id, {
      ...(verdict.outcome && { outcome: verdict.outcome }),
      outcomeReason: verdict.reason,
      outcomeAt: Date.now(),
    });
    settled += 1;
  }
  return settled;
}

export const settle = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => await settleCase(ctx, caseId),
});

// Fills in outcomes once cases verify, fail or close. Runs from a cron; does nothing when no run is waiting.
export const settlePending = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("agentRuns")
      .withIndex("by_settled", (q) => q.eq("outcomeAt", undefined))
      .take(200);
    const cases = [...new Set(pending.flatMap((run) => (run.caseId ? [run.caseId] : [])))];
    let settled = 0;
    for (const caseId of cases) settled += await settleCase(ctx, caseId);
    return { cases: cases.length, settled };
  },
});

// The owner says a diagnosis was wrong. This changes routing, so it is an owner decision behind the passcode.
export const correct = mutation({
  args: { agentRunId: v.id("agentRuns"), description: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { agentRunId, description, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    const run = await ctx.db.get(agentRunId);
    if (!run) throw new ConvexError("This agent run does not exist.");
    const text = description.trim();
    if (!text || text.length > 1000) throw new ConvexError("Say in under 1,000 characters what the diagnosis got wrong.");
    const correctedAt = Date.now();
    await ctx.db.patch(agentRunId, {
      corrections: [...run.corrections, { description: text, correctedAt, actor: { kind: "owner", identity: "owner" }, evidenceIds: [] }],
      outcome: "corrected",
      outcomeReason: `The owner corrected this diagnosis: ${text}`,
      outcomeAt: correctedAt,
    });
    return null;
  },
});
