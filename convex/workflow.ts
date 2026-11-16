import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  CLOSED_CASE_STATUSES,
  EVIDENCE_STAGES,
  STAGES,
  STAGE_IDS,
  STEP_PURPOSE_IDS,
  vCaseKind,
  vRaisedBy,
  vStage,
  vStepKind,
} from "./constants";
import type { CaseStatus, OutputRef } from "./constants";

export const MAX_ATTEMPTS = 3;

export const vStepDef = v.object({
  key: v.string(),
  title: v.string(),
  dependsOn: v.array(v.string()),
  kind: vStepKind,
  purpose: vStage,
});

export const vNewCase = v.object({
  appId: v.id("apps"),
  journeyId: v.optional(v.id("journeys")),
  title: v.string(),
  impact: v.string(),
  kind: vCaseKind,
  raisedBy: vRaisedBy,
  raisedByRef: v.optional(v.string()),
  signature: v.optional(v.string()),
  reportCount: v.optional(v.number()),
  isSample: v.optional(v.boolean()),
});

type StepDef = Infer<typeof vStepDef>;

const TEMPLATE_KINDS: Record<(typeof STAGE_IDS)[number], StepDef["kind"]> = {
  detect_or_receive: "function",
  gather_context: "function",
  investigate: "agent",
  examine_broader_causes: "agent",
  plan: "agent",
  authorize_and_execute: "approval",
  verify: "function",
  learn: "function",
};

export const TEMPLATE_STEPS: StepDef[] = STAGES.map((stage, index) => ({
  key: stage.id,
  title: stage.label,
  dependsOn: index === 0 ? [] : [STAGES[index - 1].id],
  kind: TEMPLATE_KINDS[stage.id],
  purpose: stage.id,
}));

export const EVIDENCE_TEMPLATE_STEPS: StepDef[] = TEMPLATE_STEPS.flatMap((step) =>
  step.purpose === "gather_context"
    ? [
        ...EVIDENCE_STAGES.map((stage): StepDef => ({
          key: stage.id,
          title: stage.label,
          dependsOn: ["detect_or_receive"],
          kind: "function",
          purpose: stage.id,
        })),
        { ...step, dependsOn: EVIDENCE_STAGES.map((stage) => stage.id) },
      ]
    : [step],
);

export function orderSteps<T extends { key: string; purpose: string; dependsOn: string[] }>(steps: T[]): T[] {
  const rank = (purpose: string) => {
    const index = (STEP_PURPOSE_IDS as readonly string[]).indexOf(purpose);
    return index < 0 ? STEP_PURPOSE_IDS.length : index;
  };
  const remaining = [...steps].sort((a, b) => rank(a.purpose) - rank(b.purpose) || a.key.localeCompare(b.key));
  const ordered: T[] = [];
  const visited = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex((step) => step.dependsOn.every((key) => visited.has(key)));
    if (index < 0) throw new Error("The workflow has a missing dependency or a cycle.");
    const [step] = remaining.splice(index, 1);
    ordered.push(step);
    visited.add(step.key);
  }
  return ordered;
}

function validateSteps(steps: StepDef[]) {
  const keys = new Set<string>();
  for (const step of steps) {
    if (keys.has(step.key)) throw new Error(`Duplicate step key "${step.key}".`);
    keys.add(step.key);
  }
  for (const step of steps) {
    for (const parent of step.dependsOn) {
      if (!keys.has(parent)) {
        throw new Error(`Step "${step.key}" depends on unknown step "${parent}".`);
      }
    }
  }
  const waiting = new Map(steps.map((s) => [s.key, new Set(s.dependsOn)]));
  let progressed = true;
  while (waiting.size > 0 && progressed) {
    progressed = false;
    for (const [key, parents] of waiting) {
      if (parents.size > 0) continue;
      waiting.delete(key);
      for (const rest of waiting.values()) rest.delete(key);
      progressed = true;
    }
  }
  if (waiting.size > 0) {
    throw new Error(`Steps form a cycle: ${[...waiting.keys()].join(", ")}.`);
  }
}

export async function createCaseFromTemplate(
  ctx: MutationCtx,
  fields: Infer<typeof vNewCase>,
  steps: StepDef[] = TEMPLATE_STEPS,
) {
  validateSteps(steps);
  const caseId = await ctx.db.insert("cases", { ...fields, status: "open" });
  for (const step of steps) {
    await ctx.db.insert("steps", { ...step, caseId, status: "pending" });
  }
  return caseId;
}

export async function startAttempt(ctx: MutationCtx, stepId: Id<"steps">) {
  const step = await ctx.db.get(stepId);
  if (!step) throw new Error("Step not found.");
  if (step.status !== "pending" && step.status !== "failed") {
    throw new Error(`Step "${step.key}" is ${step.status}; it cannot start an attempt.`);
  }
  const inputRefs: Id<"stepAttempts">[] = [];
  for (const key of step.dependsOn) {
    const parent = await ctx.db
      .query("steps")
      .withIndex("by_case_and_key", (q) => q.eq("caseId", step.caseId).eq("key", key))
      .unique();
    if (!parent || (parent.status !== "done" && parent.status !== "skipped")) {
      throw new Error(`Step "${step.key}" cannot start: "${key}" is not done or skipped.`);
    }
    if (parent.currentAttemptId) inputRefs.push(parent.currentAttemptId);
  }
  const last = await ctx.db
    .query("stepAttempts")
    .withIndex("by_step", (q) => q.eq("stepId", stepId))
    .order("desc")
    .first();
  if (last && last.attempt >= MAX_ATTEMPTS) {
    throw new Error(`Step "${step.key}" has used all ${MAX_ATTEMPTS} attempts.`);
  }
  const attemptId = await ctx.db.insert("stepAttempts", {
    stepId,
    caseId: step.caseId,
    attempt: (last?.attempt ?? 0) + 1,
    status: "running",
    startedAt: Date.now(),
    inputRefs,
  });
  await ctx.db.patch(stepId, { currentAttemptId: attemptId, status: "running" });
  return attemptId;
}

type AttemptNotes = {
  summary?: string;
  handoff?: string;
  error?: string;
  externalRef?: string;
  output?: unknown;
  outputRefs?: OutputRef[];
};

export async function finishAttempt(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  result: { status: "done" | "failed" } & AttemptNotes,
) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt) throw new Error("Attempt not found.");
  const step = await ctx.db.get(attempt.stepId);
  if (!step) throw new Error("Step not found.");
  if (step.currentAttemptId !== attemptId) {
    return { applied: false, reason: "not the current attempt" };
  }
  if (attempt.status === "done" || attempt.status === "failed") {
    return { applied: false, reason: "attempt already finished" };
  }
  const { status, ...notes } = result;
  await ctx.db.patch(attemptId, { status, finishedAt: Date.now(), ...notes });
  await ctx.db.patch(step._id, { status });
  return { applied: true };
}

async function loadAttempt(ctx: MutationCtx, attemptId: Id<"stepAttempts">) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt) throw new Error("Attempt not found.");
  const step = await ctx.db.get(attempt.stepId);
  if (!step) throw new Error("Step not found.");
  const live =
    step.currentAttemptId === attemptId &&
    (attempt.status === "running" || attempt.status === "waiting");
  return { attempt, step, live };
}

// Park the current attempt until an owner's decision or an external callback arrives.
export async function waitOnAttempt(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  notes: { summary: string; externalRef?: string },
) {
  const { step, live } = await loadAttempt(ctx, attemptId);
  if (!live) return { applied: false, reason: "not the current, unfinished attempt" };
  await ctx.db.patch(attemptId, { status: "waiting", ...notes });
  await ctx.db.patch(step._id, { status: "waiting" });
  return { applied: true };
}

export async function resumeAttempt(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  summary: string,
) {
  const { attempt, step, live } = await loadAttempt(ctx, attemptId);
  if (!live || attempt.status !== "waiting") {
    throw new Error(`Step "${step.key}" is not waiting on this attempt.`);
  }
  await ctx.db.patch(attemptId, { status: "running", summary });
  await ctx.db.patch(step._id, { status: "running" });
}

// Keep a result that arrived for an old or finished attempt on that attempt; the step is untouched.
export async function recordLateResult(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  notes: AttemptNotes & { status?: "done" | "failed" | "waiting" },
) {
  const { live } = await loadAttempt(ctx, attemptId);
  if (live) throw new Error("This attempt is still current; finish it instead.");
  await ctx.db.patch(attemptId, { lateResult: notes, lateResultAt: Date.now() });
}

export async function setCaseStatus(ctx: MutationCtx, caseId: Id<"cases">, status: CaseStatus) {
  const row = await ctx.db.get(caseId);
  if (!row) throw new Error("Case not found.");
  if ((CLOSED_CASE_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(`The case is already ${row.status}.`);
  }
  await ctx.db.patch(caseId, {
    status,
    ...(status === "resolved" && { resolvedAt: Date.now() }),
  });
}

export async function skipStep(ctx: MutationCtx, stepId: Id<"steps">, reason: string) {
  const step = await ctx.db.get(stepId);
  if (!step) throw new Error("Step not found.");
  if (step.status !== "pending" && step.status !== "failed") {
    throw new Error(`Step "${step.key}" is ${step.status}; it cannot be skipped.`);
  }
  const parent = await ctx.db.get(step.caseId);
  if (step.purpose === "verify" && parent?.status !== "declined") {
    throw new Error("A verify step can be skipped only on a declined case.");
  }
  await ctx.db.patch(stepId, { status: "skipped", skipReason: reason });
}

// A case's steps in stage order, each with its current attempt (or null).
export async function loadSteps(ctx: QueryCtx, caseId: Id<"cases">) {
  const steps = await ctx.db
    .query("steps")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .collect();
  return await Promise.all(
    orderSteps(steps).map(async (step) => ({
      ...step,
      currentAttempt: step.currentAttemptId
        ? await ctx.db.get(step.currentAttemptId)
        : null,
    })),
  );
}

export const createCase = internalMutation({
  args: { fields: vNewCase, steps: v.optional(v.array(vStepDef)) },
  handler: async (ctx, { fields, steps }) => createCaseFromTemplate(ctx, fields, steps),
});

export const start = internalMutation({
  args: { stepId: v.id("steps") },
  handler: async (ctx, { stepId }) => startAttempt(ctx, stepId),
});

export const finish = internalMutation({
  args: {
    attemptId: v.id("stepAttempts"),
    status: v.union(v.literal("done"), v.literal("failed")),
    summary: v.optional(v.string()),
    handoff: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { attemptId, ...result }) => finishAttempt(ctx, attemptId, result),
});

export const skip = internalMutation({
  args: { stepId: v.id("steps"), reason: v.string() },
  handler: async (ctx, { stepId, reason }) => skipStep(ctx, stepId, reason),
});
