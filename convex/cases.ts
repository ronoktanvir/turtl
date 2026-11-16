import { v } from "convex/values";
import { query } from "./_generated/server";
import { accessEnforced, canSeeCase, visibleCases } from "./access";
import {
  DEFAULT_MAX_ATTEMPTS,
  currentPermission,
  MIN_VERIFIED_RECOVERIES,
  NOT_RUN_PREFIX,
  permissionsFor,
  sourceAction,
  usesOf,
} from "./permissions";
import { latestAction, latestProposal } from "./protectedApp/records";
import { loadSteps } from "./workflow";

export const list = query({
  args: {},
  handler: async (ctx) => {
    if (accessEnforced()) return await visibleCases(ctx);
    return await ctx.db.query("cases").order("desc").collect();
  },
});

// Home screen: every case, newest first, with its steps and their current attempts.
export const listWithSteps = query({
  args: {},
  handler: async (ctx) => {
    const cases = accessEnforced() ? await visibleCases(ctx) : await ctx.db.query("cases").order("desc").collect();
    return await Promise.all(
      cases.map(async (row) => ({
        ...row,
        steps: await loadSteps(ctx, row._id),
        handledUnderPermission: !!(await latestAction(ctx, row._id))?.permissionId,
      })),
    );
  },
});

// Case screen: one case with its steps, or null when the id is not a case.
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    if (!(await canSeeCase(ctx, args.id))) return null;
    const id = ctx.db.normalizeId("cases", args.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    return { ...row, steps: await loadSteps(ctx, id) };
  },
});

// The six cards for one case: the case, its steps with their current attempts, every attempt of the
// execute step, evidence, the latest proposal, the action, verifications, agent runs, the memory this
// case matched (with when it was last verified) and the memory learned from it. Null when the id is not a case.
export const cards = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    if (!(await canSeeCase(ctx, args.id))) return null;
    const id = ctx.db.normalizeId("cases", args.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    const steps = await loadSteps(ctx, id);
    const executeStep = steps.find((s) => s.purpose === "authorize_and_execute");
    const matchedMemory = row.matchedMemoryId ? await ctx.db.get(row.matchedMemoryId) : null;
    const matchedVerification = matchedMemory ? await ctx.db.get(matchedMemory.verificationId) : null;
    const learnedMemory = await ctx.db
      .query("recoveryMemories")
      .withIndex("by_source_case", (q) => q.eq("sourceCaseId", id))
      .first();
    const action = await latestAction(ctx, id);
    const runPermission = action?.permissionId ? await ctx.db.get(action.permissionId) : null;
    const memory = matchedMemory ?? learnedMemory;
    const permissions = memory ? await permissionsFor(ctx, memory) : [];
    const active = memory ? await currentPermission(ctx, memory, Date.now()) : null;
    const source = memory ? await sourceAction(ctx, memory) : null;
    const approvalSummary = steps.find((s) => s.kind === "approval")?.currentAttempt?.summary ?? "";
    return {
      case: row,
      journey: row.journeyId ? await ctx.db.get(row.journeyId) : null,
      steps,
      executeAttempts: executeStep
        ? await ctx.db
            .query("stepAttempts")
            .withIndex("by_step", (q) => q.eq("stepId", executeStep._id))
            .collect()
        : [],
      matchedMemory: matchedMemory && {
        ...matchedMemory,
        lastVerifiedAt: matchedVerification?.completedAt ?? null,
      },
      learnedMemory,
      runPermission: runPermission && {
        ...runPermission,
        use: (await usesOf(ctx, runPermission._id)).indexOf(action!.idempotencyKey) + 1,
      },
      permissionNotRun: approvalSummary.includes(NOT_RUN_PREFIX)
        ? approvalSummary.slice(approvalSummary.indexOf(NOT_RUN_PREFIX) + NOT_RUN_PREFIX.length)
        : null,
      permissionOffer: memory && {
        memoryId: memory._id,
        timesVerified: memory.timesVerified,
        invalidated: memory.invalidatedAt !== undefined,
        actionType: memory.actionType,
        conditions: memory.conditions,
        notWhen: memory.notWhen,
        appRevision: memory.appRevision ?? null,
        target: source?.executionPayload.target ?? null,
        parameters: source?.executionPayload.parameters ?? [],
        minVerified: MIN_VERIFIED_RECOVERIES,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        active: active ? { ...active, used: (await usesOf(ctx, active._id)).length } : null,
        ended: !active && permissions[0] ? permissions[0] : null,
      },
      evidence: await ctx.db
        .query("evidence")
        .withIndex("by_case", (q) => q.eq("caseId", id))
        .collect(),
      proposal: await latestProposal(ctx, id),
      action,
      verifications: await ctx.db
        .query("verifications")
        .withIndex("by_case", (q) => q.eq("caseId", id))
        .collect(),
      agentRuns: await ctx.db
        .query("agentRuns")
        .withIndex("by_case", (q) => q.eq("caseId", id))
        .collect(),
    };
  },
});
