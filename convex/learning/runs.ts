import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const HARNESS_VERSION = "learning-v1";

// An agentRuns row for a model call this module makes. A call with no step of its own (reading a decision
// note) belongs to the case only, with no step or attempt.
export const start = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepAttemptId: v.optional(v.id("stepAttempts")),
    taskType: v.string(),
    modelId: v.string(),
    promptVersion: v.string(),
    contextRefs: v.optional(v.array(v.id("contextSources"))),
  },
  handler: async (ctx, args) => {
    const attempt = args.stepAttemptId ? await ctx.db.get(args.stepAttemptId) : null;
    if (args.stepAttemptId && attempt?.caseId !== args.caseId) return null;
    return await ctx.db.insert("agentRuns", {
      caseId: args.caseId,
      ...(attempt && { stepId: attempt.stepId, stepAttemptId: attempt._id }),
      taskType: args.taskType,
      config: {
        modelId: args.modelId,
        harnessVersion: HARNESS_VERSION,
        promptVersion: args.promptVersion,
        credentialRef: "OPENAI_API_KEY",
      },
      taskCharacteristics: {
        complexity: "one case",
        risk: args.taskType === "propose_fixes" ? "customer-facing outage" : "reads an owner note; never acts",
        framework: "Expo and Convex",
        repositoryArea: "not inspected",
      },
      contextRefs: args.contextRefs ?? [],
      routingReason: "Fixed: the only configuration for this task. No routing between configurations yet.",
      status: "running",
      corrections: [],
    });
  },
});

export const finish = internalMutation({
  args: {
    agentRunId: v.id("agentRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    durationMs: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { agentRunId, ...fields }) => {
    const run = await ctx.db.get(agentRunId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(agentRunId, fields);
  },
});
