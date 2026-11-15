import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { CLOSED_CASE_STATUSES } from "../constants";
import type { CaseStatus, Stage } from "../constants";
import {
  MAX_ATTEMPTS,
  createCaseFromTemplate,
  finishAttempt,
  loadSteps,
  recordLateResult,
  resumeAttempt,
  setCaseStatus,
  skipStep,
  startAttempt,
  vNewCase,
  waitOnAttempt,
} from "../workflow";
import { vHandlerResult } from "./contract";
import type { HandlerResult, LoadedInput } from "./contract";
import { HANDLERS } from "./handlers";

const STEP_GAP_MS = 1000;
const RETRY_DELAY_MS = 1000;
const STAGED_LATE_BY_MS = 3000;

const STATUS_ON_START: Partial<Record<Stage, CaseStatus>> = {
  detect_or_receive: "open",
  gather_context: "investigating",
  investigate: "investigating",
  examine_broader_causes: "investigating",
  plan: "investigating",
  authorize_and_execute: "waiting_for_owner",
  verify: "verifying",
};

const isClosed = (status: CaseStatus) =>
  (CLOSED_CASE_STATUSES as readonly string[]).includes(status);

const settled = (step: Doc<"steps"> | undefined) =>
  step?.status === "done" || step?.status === "skipped";

// The one entry point: insert the case with its template steps and let the runner take it.
export async function startCaseRun(ctx: MutationCtx, fields: Infer<typeof vNewCase>) {
  const caseId = await createCaseFromTemplate(ctx, fields);
  await ctx.scheduler.runAfter(0, internal.runner.run.advance, { caseId });
  return caseId;
}

export const startCase = internalMutation({
  args: { fields: vNewCase },
  handler: async (ctx, { fields }): Promise<Id<"cases">> => startCaseRun(ctx, fields),
});

async function dispatch(
  ctx: MutationCtx,
  purpose: Stage,
  attemptId: Id<"stepAttempts">,
  approvedAt?: number,
) {
  const limitMs = HANDLERS[purpose].timeoutMs;
  await ctx.scheduler.runAfter(0, internal.runner.run.execute, { attemptId, approvedAt });
  await ctx.scheduler.runAfter(limitMs, internal.runner.run.checkTimeout, {
    attemptId,
    limitMs,
  });
}

export const advance = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }): Promise<void> => {
    const row = await ctx.db.get(caseId);
    if (!row || isClosed(row.status)) return;
    const steps = await loadSteps(ctx, caseId);
    if (steps.every(settled)) {
      await setCaseStatus(ctx, caseId, "resolved");
      return;
    }
    const ready = steps.filter(
      (step) =>
        (step.status === "pending" ||
          (step.status === "failed" && (step.currentAttempt?.attempt ?? 0) < MAX_ATTEMPTS)) &&
        step.dependsOn.every((key) => settled(steps.find((s) => s.key === key))),
    );
    for (const step of ready) {
      const attemptId = await startAttempt(ctx, step._id);
      const status = STATUS_ON_START[step.purpose];
      if (status) await setCaseStatus(ctx, caseId, status);
      if (step.kind === "approval") {
        await waitOnAttempt(ctx, attemptId, {
          summary: "Waiting for the owner to approve or decline.",
        });
        continue;
      }
      await dispatch(ctx, step.purpose, attemptId);
    }
  },
});

export const loadInput = internalQuery({
  args: { attemptId: v.id("stepAttempts") },
  handler: async (ctx, { attemptId }): Promise<LoadedInput | null> => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.status !== "running") return null;
    const step = await ctx.db.get(attempt.stepId);
    const row = await ctx.db.get(attempt.caseId);
    if (!step || !row || step.currentAttemptId !== attemptId) return null;
    const consumed = await Promise.all((attempt.inputRefs ?? []).map((id) => ctx.db.get(id)));
    const parents = await Promise.all(
      step.dependsOn.map(async (key) => {
        const parent = await ctx.db
          .query("steps")
          .withIndex("by_case_and_key", (q) => q.eq("caseId", step.caseId).eq("key", key))
          .unique();
        if (!parent) throw new Error(`Step "${step.key}" depends on missing step "${key}".`);
        return { step: parent, attempt: consumed.find((a) => a?.stepId === parent._id) ?? null };
      }),
    );
    const previousAttempts = (
      await ctx.db
        .query("stepAttempts")
        .withIndex("by_step", (q) => q.eq("stepId", step._id))
        .collect()
    ).filter((a) => a._id !== attemptId);
    return { case: row, step, attempt, parents, previousAttempts };
  },
});

export const execute = internalAction({
  args: { attemptId: v.id("stepAttempts"), approvedAt: v.optional(v.number()) },
  handler: async (ctx, { attemptId, approvedAt }): Promise<void> => {
    const input: LoadedInput | null = await ctx.runQuery(internal.runner.run.loadInput, {
      attemptId,
    });
    if (!input) return;
    const { step, attempt } = input;
    const handler = HANDLERS[step.purpose];
    if (step.staged?.hang && attempt.attempt <= step.staged.hang) {
      await ctx.scheduler.runAfter(
        handler.timeoutMs + STAGED_LATE_BY_MS,
        internal.runner.run.recordResult,
        {
          attemptId,
          result: {
            status: "done",
            summary: `Staged late result (dev tools): attempt ${attempt.attempt} was held back past its time limit.`,
          },
        },
      );
      return;
    }
    let result: HandlerResult;
    if (step.staged?.fail && attempt.attempt <= step.staged.fail) {
      result = {
        status: "failed",
        error: `Staged failure (dev tools): attempt ${attempt.attempt} was set to fail.`,
      };
    } else {
      try {
        result = await handler.run(ctx, {
          ...input,
          idempotencyKey: step._id,
          approval: approvedAt === undefined ? null : { approvedAt },
        });
      } catch (error) {
        result = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await ctx.runMutation(internal.runner.run.recordResult, { attemptId, result });
  },
});

async function applyResult(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  result: HandlerResult,
) {
  const attempt = await ctx.db.get(attemptId);
  const step = attempt && (await ctx.db.get(attempt.stepId));
  const row = attempt && (await ctx.db.get(attempt.caseId));
  if (!attempt || !step || !row) return { applied: false, reason: "attempt not found" };
  if (step.kind === "approval" && row.status === "waiting_for_owner") {
    return { applied: false, reason: "the step is waiting for the owner's decision" };
  }

  const notes: {
    summary?: string;
    externalRef?: string;
    handoff?: string;
    outputRefs?: Doc<"stepAttempts">["outputRefs"];
    output?: unknown;
  } = {};
  if (result.summary !== undefined) notes.summary = result.summary;
  if (result.externalRef !== undefined) notes.externalRef = result.externalRef;
  if (result.status === "done" && result.handoff) {
    notes.handoff = result.handoff.note;
    notes.outputRefs = result.handoff.refs ?? [];
  }
  if (result.status === "done" && result.output !== undefined) notes.output = result.output;

  const live =
    step.currentAttemptId === attemptId &&
    (attempt.status === "running" || attempt.status === "waiting");
  if (!live) {
    await recordLateResult(ctx, attemptId, notes);
    return { applied: false, reason: "late: not the step's current, unfinished attempt" };
  }

  if (result.status === "waiting") {
    await waitOnAttempt(ctx, attemptId, { ...notes, summary: result.summary });
  } else {
    await finishAttempt(ctx, attemptId, {
      ...notes,
      status: result.status,
      ...(result.status === "failed" && { error: result.error }),
    });
  }
  if (isClosed(row.status)) return { applied: true };

  if (result.status !== "failed" && result.caseStatus) {
    await setCaseStatus(ctx, row._id, result.caseStatus);
  }
  if (result.status === "waiting") return { applied: true };
  if (result.status === "done") {
    await ctx.scheduler.runAfter(STEP_GAP_MS, internal.runner.run.advance, { caseId: row._id });
  } else if (attempt.attempt >= MAX_ATTEMPTS) {
    await setCaseStatus(ctx, row._id, "unresolved");
  } else {
    await ctx.scheduler.runAfter(RETRY_DELAY_MS, internal.runner.run.advance, {
      caseId: row._id,
    });
  }
  return { applied: true };
}

// Where every result lands: the runner's own handlers now, external callbacks later.
export const recordResult = internalMutation({
  args: { attemptId: v.id("stepAttempts"), result: vHandlerResult },
  handler: async (ctx, { attemptId, result }) => applyResult(ctx, attemptId, result),
});

export const checkTimeout = internalMutation({
  args: { attemptId: v.id("stepAttempts"), limitMs: v.number() },
  handler: async (ctx, { attemptId, limitMs }) => {
    const attempt = await ctx.db.get(attemptId);
    const step = attempt && (await ctx.db.get(attempt.stepId));
    if (!attempt || !step || step.currentAttemptId !== attemptId) return null;
    if (attempt.status !== "running" && attempt.status !== "waiting") return null;
    return await applyResult(ctx, attemptId, {
      status: "failed",
      error: `Timed out after ${limitMs / 1000} s with no result. Its outcome is unknown: check any external work it started (externalRef) before repeating it.`,
    });
  },
});

async function waitingApproval(ctx: MutationCtx, caseId: Id<"cases">) {
  const row = await ctx.db.get(caseId);
  if (!row) throw new Error("Case not found.");
  if (row.status !== "waiting_for_owner") {
    throw new Error(`The case is ${row.status}; it is not waiting for the owner.`);
  }
  const steps = await loadSteps(ctx, caseId);
  const step = steps.find((s) => s.kind === "approval" && s.status === "waiting");
  if (!step?.currentAttemptId) throw new Error("No step is waiting for approval.");
  return { steps, step, attemptId: step.currentAttemptId };
}

export async function approveCase(ctx: MutationCtx, caseId: Id<"cases">) {
  const { step, attemptId } = await waitingApproval(ctx, caseId);
  await resumeAttempt(ctx, attemptId, "Approved by the owner.");
  await setCaseStatus(ctx, caseId, "executing");
  await dispatch(ctx, step.purpose, attemptId, Date.now());
}

export async function declineCase(ctx: MutationCtx, caseId: Id<"cases">) {
  const { steps, attemptId } = await waitingApproval(ctx, caseId);
  await finishAttempt(ctx, attemptId, {
    status: "done",
    summary: "Declined by the owner. Nothing was executed.",
  });
  await setCaseStatus(ctx, caseId, "declined");
  for (const rest of steps) {
    if (rest.status === "pending") {
      await skipStep(ctx, rest._id, "The owner declined, so this step did not run.");
    }
  }
}

export const approve = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => approveCase(ctx, caseId),
});

export const decline = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => declineCase(ctx, caseId),
});
