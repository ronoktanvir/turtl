import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vContextSource } from "../constants";

export const vDecisionOutcome = v.union(
  v.literal("approved"),
  v.literal("chose_other"),
  v.literal("declined"),
  v.literal("stopped"),
);
export const vSuggestionSource = v.union(v.literal("chat"), v.literal("decision_note"));
export const vSuggestionStatus = v.union(v.literal("pending"), v.literal("saved"), v.literal("dismissed"));

// Owner preferences, feedback and context learning (README.md in this folder). Spread into convex/schema.ts.
export const learningTables = {
  // One row per owner decision on a proposal: what turtl recommended against what the owner did.
  ownerDecisions: defineTable({
    appId: v.id("apps"),
    caseId: v.id("cases"),
    proposalId: v.id("proposals"),
    proposalVersion: v.number(),
    outcome: vDecisionOutcome,
    recommendedKey: v.optional(v.string()),
    recommendedTitle: v.optional(v.string()),
    chosenKey: v.optional(v.string()),
    chosenTitle: v.optional(v.string()),
    turnedDownTitle: v.optional(v.string()),
    turnedDownFingerprint: v.optional(v.string()),
    conditionsKey: v.string(),
    conditionsText: v.string(),
    note: v.optional(v.string()),
    decidedAt: v.number(),
  })
    .index("by_app_and_conditions", ["appId", "conditionsKey"])
    .index("by_app", ["appId"])
    .index("by_case", ["caseId"]),
  // A preference turtl heard in a decision note or the case chat. It becomes an ownerPreferences row only when the owner confirms it.
  preferenceSuggestions: defineTable({
    appId: v.id("apps"),
    caseId: v.optional(v.id("cases")),
    statement: v.string(),
    source: vSuggestionSource,
    chatMessageId: v.optional(v.id("fixChatMessages")),
    decisionId: v.optional(v.id("ownerDecisions")),
    status: vSuggestionStatus,
    preferenceId: v.optional(v.id("ownerPreferences")),
    createdAt: v.number(),
  })
    .index("by_app_and_status", ["appId", "status"])
    .index("by_message", ["chatMessageId"]),
  // Each context source gather_context supplied to one case, and whether a verified fix used it.
  contextUses: defineTable({
    appId: v.id("apps"),
    caseId: v.id("cases"),
    stepAttemptId: v.id("stepAttempts"),
    contextSourceId: v.id("contextSources"),
    kind: vContextSource.fields.kind,
    sourceRef: v.string(),
    label: v.string(),
    appRevision: v.optional(v.string()),
    rank: v.number(),
    helpedBefore: v.boolean(),
    stale: v.boolean(),
    staleNote: v.optional(v.string()),
    used: v.optional(v.boolean()),
    helped: v.optional(v.boolean()),
    markedAt: v.optional(v.number()),
  })
    .index("by_case", ["caseId"])
    .index("by_source", ["contextSourceId"]),
};
