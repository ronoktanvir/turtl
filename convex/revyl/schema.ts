import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vScreenshotPhase = v.union(v.literal("failure"), v.literal("before"), v.literal("after"));
export const vRevylRunStatus = v.union(
  v.literal("running"),
  v.literal("passed"),
  v.literal("failed"),
  v.literal("error"),
);

// Revyl runs of a journey on a cloud device, and the screenshots kept from them. Spread into convex/schema.ts.
export const revylTables = {
  revylRuns: defineTable({
    caseId: v.optional(v.id("cases")),
    stepAttemptId: v.optional(v.id("stepAttempts")),
    phase: vScreenshotPhase,
    workflowId: v.string(),
    credentialRef: v.optional(v.string()),
    taskId: v.string(),
    status: vRevylRunStatus,
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    summary: v.optional(v.string()),
    reportUrl: v.optional(v.string()),
  }).index("by_case", ["caseId"]),
  revylScreenshots: defineTable({
    runId: v.id("revylRuns"),
    caseId: v.optional(v.id("cases")),
    phase: vScreenshotPhase,
    storageId: v.id("_storage"),
    caption: v.string(),
    takenAt: v.number(),
  })
    .index("by_case", ["caseId"])
    .index("by_run", ["runId"]),
};
