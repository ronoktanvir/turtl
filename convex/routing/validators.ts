import { v } from "convex/values";

// Routing fields stored on each agentRuns row (spread into vAgentRun in convex/constants.ts).

export const vOutcome = v.union(
  v.literal("verified"),
  v.literal("corrected"),
  v.literal("failed"),
  v.literal("infra_failure"),
);

export const vTraits = v.object({
  caseKind: v.string(),
  reproduces: v.union(v.literal("yes"), v.literal("no"), v.literal("unknown")),
  signals: v.array(v.string()),
  components: v.array(v.string()),
  evidenceKinds: v.number(),
  evidenceExpected: v.number(),
  memory: v.union(v.literal("none"), v.literal("look_alike_rejected"), v.literal("matched")),
  familiarFailure: v.boolean(),
  failure: v.string(),
  consequence: v.union(v.literal("low"), v.literal("high")),
  consequenceWhy: v.string(),
});

export const vRouting = v.object({
  configKey: v.string(),
  configLabel: v.string(),
  provider: v.string(),
  traits: v.optional(vTraits),
  bucket: v.optional(v.string()),
  difficulty: v.optional(v.number()),
  limits: v.optional(v.object({ timeLeftMs: v.number(), budgetLeftUsd: v.number() })),
  escalatedFromRunId: v.optional(v.id("agentRuns")),
  escalatedToRunId: v.optional(v.id("agentRuns")),
  handoff: v.optional(v.string()),
  councilReviewId: v.optional(v.id("councilReviews")),
});

export const agentRunRoutingFields = {
  routing: v.optional(vRouting),
  outcome: v.optional(vOutcome),
  outcomeReason: v.optional(v.string()),
  outcomeAt: v.optional(v.number()),
  usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number() })),
};
