import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  STAGES,
  STAGE_IDS,
  vCaseKind,
  vRaisedBy,
  vStage,
  vStepKind,
} from "./constants";

export const vStepDef = v.object({
  key: v.string(),
  title: v.string(),
  dependsOn: v.array(v.string()),
  kind: vStepKind,
  purpose: vStage,
});

export const vNewCase = v.object({
  appId: v.id("apps"),
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

// The initial template: the eight stages as a linear chain.
export const TEMPLATE_STEPS: StepDef[] = STAGES.map((stage, index) => ({
  key: stage.id,
  title: stage.label,
  dependsOn: index === 0 ? [] : [STAGES[index - 1].id],
  kind: TEMPLATE_KINDS[stage.id],
  purpose: stage.id,
}));

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
  for (const key of step.dependsOn) {
    const parent = await ctx.db
      .query("steps")
      .withIndex("by_case_and_key", (q) => q.eq("caseId", step.caseId).eq("key", key))
      .unique();
    if (!parent || (parent.status !== "done" && parent.status !== "skipped")) {
      throw new Error(`Step "${step.key}" cannot start: "${key}" is not done or skipped.`);
    }
  }
  const last = await ctx.db
    .query("stepAttempts")
    .withIndex("by_step", (q) => q.eq("stepId", stepId))
    .order("desc")
    .first();
  const attemptId = await ctx.db.insert("stepAttempts", {
    stepId,
    caseId: step.caseId,
    attempt: (last?.attempt ?? 0) + 1,
    status: "running",
    startedAt: Date.now(),
  });
  await ctx.db.patch(stepId, { currentAttemptId: attemptId, status: "running" });
  return attemptId;
}

export async function finishAttempt(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  result: {
    status: "done" | "failed";
    summary?: string;
    handoff?: string;
    error?: string;
  },
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
  steps.sort((a, b) => STAGE_IDS.indexOf(a.purpose) - STAGE_IDS.indexOf(b.purpose));
  return await Promise.all(
    steps.map(async (step) => ({
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
