import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vTriageVerdict = v.union(v.literal("bug"), v.literal("request"), v.literal("noise"));
export const vReportHint = v.union(v.literal("bug"), v.literal("request"));

export const intakeTables = {
  // Public intake keys: one names one app in a customer's report form. A key is an identifier, not a secret.
  intakeKeys: defineTable({
    appId: v.id("apps"),
    key: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_app", ["appId"])
    .index("by_app_and_revoked", ["appId", "revokedAt"]),
  // Fixed-window counters behind the intake endpoint's rate limits.
  intakeRateWindows: defineTable({
    bucket: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_bucket_and_window", ["bucket", "windowStart"]),
  // One triage per report: what it was judged to be, how, and where it landed.
  reportTriage: defineTable({
    reportId: v.id("reports"),
    appId: v.id("apps"),
    fingerprint: v.string(),
    hint: v.optional(vReportHint),
    // Legacy: a customer's contact as written. No longer stored (only a hash reaches the report's fromRef);
    // intake/records:forgetStoredContacts clears old rows. Drop the field once that has run everywhere.
    contact: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("done")),
    verdict: v.optional(vTriageVerdict),
    source: v.optional(v.union(v.literal("exact_copy"), v.literal("model"), v.literal("rules"))),
    outcome: v.optional(v.union(v.literal("attached"), v.literal("opened"), v.literal("ignored"))),
    caseId: v.optional(v.id("cases")),
    reason: v.optional(v.string()),
    suggestedCaseIds: v.optional(v.array(v.id("cases"))),
    modelId: v.optional(v.string()),
    modelError: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    agentRunId: v.optional(v.id("agentRuns")),
    triagedAt: v.optional(v.number()),
  })
    .index("by_report", ["reportId"])
    .index("by_app_and_status", ["appId", "status"])
    .index("by_case", ["caseId"]),
  // Serializes triage per app, so a report can match the case the report before it opened.
  intakeLocks: defineTable({ appId: v.id("apps"), until: v.number() }).index("by_app", ["appId"]),
};
