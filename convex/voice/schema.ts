import { defineTable } from "convex/server";
import { v } from "convex/values";

// One row per spoken turn on a case: what the per-case rate limit counts, and how each turn ended.
// No audio and no transcript is kept here; the transcript becomes the owner's message in the case chat.
export const voiceTables = {
  voiceTurns: defineTable({
    caseId: v.id("cases"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    outcome: v.optional(
      v.union(
        v.literal("answered"),
        v.literal("command"),
        v.literal("ended"),
        v.literal("no_speech"),
        v.literal("failed"),
      ),
    ),
    error: v.optional(v.string()),
  }).index("by_case_and_start", ["caseId", "startedAt"]),
};
