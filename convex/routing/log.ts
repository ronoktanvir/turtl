import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { mutation } from "../functions";
import { accessEnforced, guardRow } from "../access";
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
      // A diagnosis is scored once its case has a result: the settling cron looks at it from the next tick, with the
      // runs whose time has come, so runs that are never scored (however many) cannot hold it up.
      ...(args.taskType === DIAGNOSIS_TASK && { nextSettleAt: Date.now() }),
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

// Settling outcomes is shared by every account's runs, so each run gets its own turn (second review, finding 15: the
// cron took the 200 oldest unsettled runs, and a run that can never settle, such as a repository reading with no case,
// or a run on a case its owner leaves open, kept every newer run waiting for ever). A run nothing has looked at is
// looked at once: one that is not scored is settled at once; a diagnosis run waiting on its case gets a next time to
// look, less often as it ages, and after NEVER_FINISHED_MS is settled as never finished.

/** Runs one look takes of each kind (never looked at, and due again); the look runs again while either comes back full. */
const SETTLE_BATCH = 100;
const SETTLE_ROUNDS = 20;
/** The cron's interval (convex/crons.ts): how often a new diagnosis run is looked at in its first hour. */
const SETTLE_EVERY_MS = 2 * 60_000;
/** Then every 10 minutes for its first day, then once an hour: the floor. */
const SETTLE_STEPS: readonly { after: number; every: number }[] = [
  { after: 60 * 60_000, every: 10 * 60_000 },
  { after: 24 * 60 * 60_000, every: 60 * 60_000 },
];
/** A diagnosis run whose case has not finished after this long is settled as never finished, and followed no more. */
export const NEVER_FINISHED_MS = 30 * 24 * 60 * 60_000;
/** A case's newest verifications read to decide its result. */
const VERIFICATIONS_READ = 50;

const NOT_SCORED = {
  council: "Not scored: a council answer is an input to the proposal, not a diagnosis a fix tests.",
  other: "Not scored: only diagnosis runs are scored for routing.",
  neverFinished: "Not counted: its case had not finished 30 days after the diagnosis, so turtl stopped waiting for it.",
  noCase: "Not counted: its case no longer exists.",
};

/** When to look at a waiting diagnosis run next, by its age; a little early, so it is due at the tick after its time. */
export function nextSettleAt(createdAt: number, now: number): number {
  const age = now - createdAt;
  const step = [...SETTLE_STEPS].reverse().find((candidate) => age >= candidate.after);
  return now + (step?.every ?? SETTLE_EVERY_MS) - 10_000;
}

// The case's result as far as routing is concerned, or null while it is still open. A declined fix is not counted:
// the owner's choice says nothing about whether the diagnosis was right.
async function caseVerdict(ctx: MutationCtx, caseId: Id<"cases">): Promise<CaseVerdict> {
  const row = await ctx.db.get(caseId);
  if (!row) return { reason: NOT_SCORED.noCase };
  const verifications = await ctx.db.query("verifications").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("desc").take(VERIFICATIONS_READ);
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

/**
 * Settles one run if it can be, or says when to look at it next. A run still running is waited for. A run that is not
 * a diagnosis is never scored, so it is settled as soon as it is done; a diagnosis run is settled with its case's
 * result once the case has one, or as never finished once it is NEVER_FINISHED_MS old. `verdictOf` caches cases.
 */
async function settleRun(ctx: MutationCtx, run: Doc<"agentRuns">, verdictOf: (caseId: Id<"cases">) => Promise<CaseVerdict>, now: number) {
  if (run.outcomeAt !== undefined) return true;
  const busy = run.status === "running" || run.status === "queued";
  if (!busy && run.taskType !== DIAGNOSIS_TASK) {
    await ctx.db.patch(run._id, { outcomeReason: run.taskType.startsWith("council_") ? NOT_SCORED.council : NOT_SCORED.other, outcomeAt: now, nextSettleAt: undefined });
    return true;
  }
  const verdict = !busy && run.caseId ? await verdictOf(run.caseId) : null;
  if (verdict) {
    await ctx.db.patch(run._id, { ...(verdict.outcome && { outcome: verdict.outcome }), outcomeReason: verdict.reason, outcomeAt: now, nextSettleAt: undefined });
    return true;
  }
  if (now - run._creationTime >= NEVER_FINISHED_MS) {
    await ctx.db.patch(run._id, { outcomeReason: NOT_SCORED.neverFinished, outcomeAt: now, nextSettleAt: undefined });
    return true;
  }
  await ctx.db.patch(run._id, { nextSettleAt: nextSettleAt(run._creationTime, now) });
  return false;
}

function verdicts(ctx: MutationCtx) {
  const seen = new Map<Id<"cases">, Promise<CaseVerdict>>();
  return (caseId: Id<"cases">) => {
    if (!seen.has(caseId)) seen.set(caseId, caseVerdict(ctx, caseId));
    return seen.get(caseId)!;
  };
}

/** Settles a case's runs (its newest SETTLE_BATCH) once it has a result. */
export async function settleCase(ctx: MutationCtx, caseId: Id<"cases">) {
  const verdictOf = verdicts(ctx);
  if (!(await verdictOf(caseId))) return 0;
  const runs = await ctx.db.query("agentRuns").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("desc").take(SETTLE_BATCH);
  let settled = 0;
  for (const run of runs) if (run.outcomeAt === undefined && run.taskType === DIAGNOSIS_TASK && (await settleRun(ctx, run, verdictOf, Date.now()))) settled += 1;
  return settled;
}

export const settle = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => await settleCase(ctx, caseId),
});

// Fills in outcomes once cases verify, fail or close. Runs from a cron; does nothing when no run is waiting. Takes
// the runs nothing has looked at yet and the runs whose next look has come, each with its own budget, and runs again
// at once while either comes back full, up to SETTLE_ROUNDS times a tick.
export const settlePending = internalMutation({
  args: { round: v.optional(v.number()) },
  returns: v.object({ looked: v.number(), settled: v.number() }),
  handler: async (ctx, { round = 0 }) => {
    const now = Date.now();
    const fresh = await ctx.db
      .query("agentRuns")
      .withIndex("by_settled_and_next", (q) => q.eq("outcomeAt", undefined).eq("nextSettleAt", undefined))
      .take(SETTLE_BATCH);
    const due = await ctx.db
      .query("agentRuns")
      .withIndex("by_settled_and_next", (q) => q.eq("outcomeAt", undefined).gte("nextSettleAt", 0).lte("nextSettleAt", now))
      .take(SETTLE_BATCH);
    const verdictOf = verdicts(ctx);
    let settled = 0;
    for (const run of [...fresh, ...due]) if (await settleRun(ctx, run, verdictOf, now)) settled += 1;
    if ((fresh.length === SETTLE_BATCH || due.length === SETTLE_BATCH) && round + 1 < SETTLE_ROUNDS) {
      await ctx.scheduler.runAfter(0, internal.routing.log.settlePending, { round: round + 1 });
    }
    return { looked: fresh.length + due.length, settled };
  },
});

// The owner says a diagnosis was wrong. This changes routing, so it is an owner decision behind the passcode.
export const correct = mutation({
  args: { agentRunId: v.id("agentRuns"), description: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { agentRunId, description, passcode }) => {
    const account = await guardRow(ctx, "agentRuns", agentRunId, "This agent run does not exist.");
    await requireOwnerPasscode(ctx, passcode);
    const run = await ctx.db.get(agentRunId);
    if (!run) throw new ConvexError("This agent run does not exist.");
    const text = description.trim();
    if (!text || text.length > 1000) throw new ConvexError("Say in under 1,000 characters what the diagnosis got wrong.");
    const correctedAt = Date.now();
    await ctx.db.patch(agentRunId, {
      corrections: [...run.corrections, { description: text, correctedAt, actor: { kind: "owner", identity: accessEnforced() ? account : "owner" }, evidenceIds: [] }],
      outcome: "corrected",
      outcomeReason: `The owner corrected this diagnosis: ${text}`,
      outcomeAt: correctedAt,
    });
    return null;
  },
});
