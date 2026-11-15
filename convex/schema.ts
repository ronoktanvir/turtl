import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vCaseKind,
  vCaseStatus,
  vRaisedBy,
  vStage,
  vStepStatus,
} from "./constants";

export default defineSchema({
  cases: defineTable({
    title: v.string(),
    kind: vCaseKind,
    raisedBy: vRaisedBy,
    status: vCaseStatus,
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  }),
  steps: defineTable({
    caseId: v.id("cases"),
    stage: vStage,
    status: vStepStatus,
    attempt: v.number(),
    summary: v.string(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_case", ["caseId"]),
});
