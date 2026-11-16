import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// One agentRuns row per model call the case chat or a voice turn makes. These calls belong to a case,
// not to a workflow step, so the step and attempt links are left empty.
export const record = internalMutation({
  args: {
    caseId: v.id("cases"),
    taskType: v.string(),
    modelId: v.string(),
    promptVersion: v.string(),
    routingReason: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    durationMs: v.number(),
  },
  handler: async (ctx, { caseId, taskType, modelId, promptVersion, routingReason, ok, error, durationMs }) => {
    await ctx.db.insert("agentRuns", {
      caseId,
      taskType,
      config: { modelId, harnessVersion: "case-chat-1", promptVersion },
      taskCharacteristics: { complexity: "low", risk: "none: answers only, never acts", framework: "n/a", repositoryArea: "case chat" },
      contextRefs: [],
      routingReason,
      status: ok ? "completed" : "failed",
      ...(error ? { error } : {}),
      corrections: [],
      durationMs,
    });
  },
});
