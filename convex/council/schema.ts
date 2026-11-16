import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vCouncilMember = v.object({
  provider: v.union(v.literal("openai"), v.literal("anthropic"), v.literal("google")),
  model: v.string(),
  reasoning: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
});

export const vCouncilAnswer = v.object({
  provider: v.string(),
  model: v.string(),
  label: v.string(),
  status: v.union(v.literal("answered"), v.literal("failed"), v.literal("not_run")),
  agentRunId: v.optional(v.id("agentRuns")),
  hypothesis: v.optional(v.string()),
  confidence: v.optional(v.number()),
  supportingEvidenceIds: v.array(v.string()),
  missingEvidence: v.array(v.string()),
  wouldDisprove: v.optional(v.string()),
  error: v.optional(v.string()),
  costUsd: v.optional(v.number()),
  durationMs: v.optional(v.number()),
});

export const vConsolidation = v.object({
  source: v.union(v.literal("model"), v.literal("rules")),
  agentRunId: v.optional(v.id("agentRuns")),
  model: v.optional(v.string()),
  summary: v.string(),
  agreements: v.array(v.string()),
  disagreements: v.array(v.string()),
  missingEvidence: v.array(v.string()),
});

export const councilTables = {
  // Which models sit on an app's council. With no row, the server default in council/settings.ts applies.
  councilSettings: defineTable({
    appId: v.id("apps"),
    members: v.array(vCouncilMember),
    consolidator: v.optional(vCouncilMember),
    maxCostUsd: v.number(),
    updatedAt: v.number(),
  }).index("by_app", ["appId"]),
  // One council examination of one case's evidence. An input to the proposal: never verification, never authorization.
  councilReviews: defineTable({
    appId: v.id("apps"),
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    purpose: v.union(v.literal("diagnosis"), v.literal("structural")),
    question: v.string(),
    failure: v.optional(v.string()),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("skipped"), v.literal("failed")),
    skippedReason: v.optional(v.string()),
    members: v.array(vCouncilAnswer),
    consolidation: v.optional(vConsolidation),
    notice: v.string(),
    costUsd: v.number(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_case", ["caseId"])
    .index("by_app", ["appId", "startedAt"]),
};
