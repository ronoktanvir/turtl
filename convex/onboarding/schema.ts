import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vGithubSnapshot } from "../prTracking/validators";

export const vItemKey = v.union(
  v.literal("error_logs"),
  v.literal("health_check"),
  v.literal("readiness_check"),
  v.literal("journey_checks"),
  v.literal("feature_flags"),
  v.literal("recovery_hooks"),
  v.literal("test_fixtures"),
);
export const vFileRef = v.object({ path: v.string(), line: v.optional(v.number()) });
export const vReadinessItem = v.object({
  key: vItemKey,
  status: v.union(v.literal("found"), v.literal("missing"), v.literal("unknown")),
  note: v.string(),
  files: v.array(vFileRef),
});
export const vStack = v.object({ id: v.string(), label: v.string(), supported: v.boolean(), evidence: v.array(v.string()) });
export const vNeverBreak = v.object({
  id: v.string(),
  text: v.string(),
  suggested: v.boolean(),
  why: v.optional(v.string()),
  addCheck: v.boolean(),
});
export const vLiveCheck = v.object({
  kind: v.union(v.literal("health"), v.literal("readiness"), v.literal("journey"), v.literal("flag"), v.literal("recovery_hook")),
  name: v.string(),
  url: v.string(),
  state: v.union(v.literal("works"), v.literal("failing"), v.literal("no_response")),
  detail: v.string(),
  journeyId: v.optional(v.id("journeys")),
  actionCatalogId: v.optional(v.id("actionCatalog")),
  checkedAt: v.number(),
});

export const onboardingTables = {
  // One read of the repository: what turtl found for each readiness item, at which commit, and who judged it.
  onboardingInspections: defineTable({
    appId: v.id("apps"),
    repo: v.string(),
    folders: v.array(v.string()),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    ref: v.optional(v.string()),
    defaultBranch: v.optional(v.string()),
    stack: v.optional(vStack),
    items: v.array(vReadinessItem),
    summary: v.optional(v.string()),
    suggestions: v.array(v.object({ text: v.string(), why: v.string() })),
    hasManifest: v.optional(v.boolean()),
    filesRead: v.optional(v.number()),
    judgedBy: v.optional(v.union(v.literal("model"), v.literal("rules"))),
    fallbackReason: v.optional(v.string()),
    readNote: v.optional(v.string()),
    agentRunId: v.optional(v.id("agentRuns")),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_app", ["appId"]),
  // The owner's answers, approval, the one preparation pull request, and what was registered after it merged.
  // Only the owner's Merge tap merges it, with checks passing on the head they were shown.
  onboardingPreparations: defineTable({
    appId: v.id("apps"),
    neverBreak: v.array(vNeverBreak),
    answeredAt: v.optional(v.number()),
    approvedAt: v.optional(v.number()),
    inspectionId: v.optional(v.id("onboardingInspections")),
    requestId: v.optional(v.string()),
    brief: v.optional(v.string()),
    repo: v.optional(v.string()),
    baseBranch: v.optional(v.string()),
    capyThreadId: v.optional(v.string()),
    capyCursor: v.optional(v.string()),
    number: v.optional(v.number()),
    snapshot: v.optional(vGithubSnapshot),
    requestedAt: v.optional(v.number()),
    syncedAt: v.optional(v.number()),
    // When the cron next reads it (convex/prTracking/follow.ts), from its approval until it settles; NOT_FOLLOWED
    // (records.ts) while it is not approved. Missing on a row from before it was kept: due now if approved.
    nextSyncAt: v.optional(v.number()),
    syncError: v.optional(v.string()),
    openError: v.optional(v.string()),
    // Why turtl handed an approval back without starting anything (no coding agent, or the repository is not
    // connected), so the owner can fix it and approve again.
    blocked: v.optional(v.string()),
    mergeRequestedAt: v.optional(v.number()),
    mergedAt: v.optional(v.number()),
    mergedBy: v.optional(v.union(v.literal("owner"), v.literal("github"))),
    mergeCommitSha: v.optional(v.string()),
    settledAt: v.optional(v.number()),
    registration: v.optional(
      v.object({
        status: v.union(v.literal("checking"), v.literal("done"), v.literal("failed")),
        ref: v.optional(v.string()),
        error: v.optional(v.string()),
        // What turtl left out of turtl.json, such as entries past MAX_MANIFEST_ENTRIES.
        note: v.optional(v.string()),
        checks: v.array(vLiveCheck),
        checkedAt: v.optional(v.number()),
        // When the owner last asked turtl to check again; with accounts on it limits how often they can.
        requestedAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_app", ["appId"])
    .index("by_settled_and_approved", ["settledAt", "approvedAt"])
    .index("by_settled_and_next_sync", ["settledAt", "nextSyncAt"]),
};
