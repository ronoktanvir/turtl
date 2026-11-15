import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vIncidentStatus, vStage, vStepStatus } from "./constants";

export default defineSchema({
  incidents: defineTable({
    title: v.string(),
    status: vIncidentStatus,
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  }),
  steps: defineTable({
    incidentId: v.id("incidents"),
    stage: vStage,
    status: vStepStatus,
    attempt: v.number(),
    summary: v.string(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_incident", ["incidentId"]),
});
