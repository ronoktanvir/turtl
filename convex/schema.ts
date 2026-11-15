import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vAttemptStatus,
  vCaseKind,
  vCaseStatus,
  vRaisedBy,
  vStage,
  vStepKind,
  vStepStatus,
} from "./constants";

export default defineSchema({
  apps: defineTable({
    name: v.string(),
    repoUrl: v.optional(v.string()),
    productionUrl: v.optional(v.string()),
    revision: v.optional(v.string()),
    ownerId: v.optional(v.string()),
    isSample: v.optional(v.boolean()),
  }),
  cases: defineTable({
    appId: v.id("apps"),
    title: v.string(),
    impact: v.string(),
    kind: vCaseKind,
    raisedBy: vRaisedBy,
    raisedByRef: v.optional(v.string()),
    status: vCaseStatus,
    signature: v.optional(v.string()),
    reportCount: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    isSample: v.optional(v.boolean()),
  }),
  steps: defineTable({
    caseId: v.id("cases"),
    key: v.string(),
    title: v.string(),
    dependsOn: v.array(v.string()),
    kind: vStepKind,
    purpose: vStage,
    status: vStepStatus,
    skipReason: v.optional(v.string()),
    currentAttemptId: v.optional(v.id("stepAttempts")),
  })
    .index("by_case", ["caseId"])
    .index("by_case_and_key", ["caseId", "key"]),
  stepAttempts: defineTable({
    stepId: v.id("steps"),
    caseId: v.id("cases"),
    attempt: v.number(),
    status: vAttemptStatus,
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    summary: v.optional(v.string()),
    handoff: v.optional(v.string()),
    error: v.optional(v.string()),
    externalRef: v.optional(v.string()),
  })
    .index("by_step", ["stepId"])
    .index("by_case", ["caseId"]),
});
