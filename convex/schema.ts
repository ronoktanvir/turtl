import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { bookingError } from "./bookingDemo/validators";
import { codeNetworkTables } from "./codeNetwork/schema";
import { vPullRequestRow } from "./prTracking/validators";
import {
  vAttemptStatus,
  vCaseKind,
  vCaseStatus,
  vOutputRef,
  vRaisedBy,
  vStage,
  vStepKind,
  vStepStatus,
  vJourney,
  vActionCatalogEntry,
  vReport,
  vEvidence,
  vProposal,
  vAction,
  vVerification,
  vRecoveryMemory,
  vOwnerPreference,
  vPermission,
  vAgentRun,
  vContextSource,
} from "./constants";
import { revylTables } from "./revyl/schema";
import { externalAppTables } from "./externalApp/schema";

export default defineSchema({
  // Mutations must enforce ownerId access; isSample and optional ownership do not grant production access.
  apps: defineTable({
    name: v.string(),
    repoUrl: v.optional(v.string()),
    productionUrl: v.optional(v.string()),
    revision: v.optional(v.string()),
    ownerId: v.optional(v.string()),
    isSample: v.optional(v.boolean()),
  }),
  // Mutations must enforce app ownership and same-app journey/memory links; restored service is not a completed permanent repair.
  cases: defineTable({
    appId: v.id("apps"),
    journeyId: v.optional(v.id("journeys")),
    matchedMemoryId: v.optional(v.id("recoveryMemories")),
    title: v.string(),
    impact: v.string(),
    kind: vCaseKind,
    raisedBy: vRaisedBy,
    raisedByRef: v.optional(v.string()),
    status: vCaseStatus,
    signature: v.optional(v.string()),
    reportCount: v.optional(v.number()),
    distinctRequesterCount: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    isSample: v.optional(v.boolean()),
  }).index("by_app_and_signature", ["appId", "signature"]),
  // Mutations must maintain one workflow per case, unique step keys, acyclic validated additions, and completed history; memory skips require fresh applicability and executed changes require verification.
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
    staged: v.optional(
      v.object({ fail: v.optional(v.number()), hang: v.optional(v.number()) }),
    ),
  })
    .index("by_case", ["caseId"])
    .index("by_case_and_key", ["caseId", "key"]),
  // Mutations must allocate increasing attempt numbers per stable step, preserve old attempts, accept only current-attempt callbacks, and hand off structured references alongside notes.
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
    inputRefs: v.optional(v.array(v.id("stepAttempts"))),
    output: v.optional(v.any()),
    outputRefs: v.optional(v.array(vOutputRef)),
    lateResultAt: v.optional(v.number()),
  })
    .index("by_step", ["stepId"])
    .index("by_case", ["caseId"]),
  // Mutations must enforce app ownership, immutable check versions, and credential references (never secrets).
  journeys: defineTable(vJourney).index("by_app", ["appId"]),
  // Mutations must enforce app ownership and validate parameters against this catalog before approval or execution.
  actionCatalog: defineTable(vActionCatalogEntry).index("by_app_and_type", [
    "appId",
    "type",
  ]),
  // Mutations must deduplicate provider/event pairs, check case ownership, and count distinct fromRef identities separately from messages.
  reports: defineTable(vReport)
    .index("by_app_and_provider_event", [
      "appId",
      "provider",
      "providerEventId",
    ])
    .index("by_case_and_requester", ["caseId", "fromRef"]),
  // Mutations must check case/step/attempt ownership and preserve the observation's original environment and revision.
  evidence: defineTable(vEvidence)
    .index("by_case", ["caseId"])
    .index("by_attempt", ["stepAttemptId"]),
  // Mutations must allocate increasing versions per step, freeze decided versions, require actor/time for decisions, and validate chosenKey, unique criteria/option keys, catalog targets and parameters (including rejecting unknown or duplicate parameter names).
  proposals: defineTable(vProposal)
    .index("by_case", ["caseId"])
    .index("by_step_and_version", ["stepId", "version"]),
  // Mutations must snapshot the version/payload atomically with approval, enforce actor/environment consistency and allowed transitions, reserve a unique idempotency key, and reconcile unknown outcomes before retries.
  actions: defineTable(vAction)
    .index("by_case", ["caseId"])
    .index("by_proposal", ["proposalId"])
    .index("by_permission", ["permissionId"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_status", ["status"]),
  // Mutations must match the exact action/attempt/environment/revision and check versions, include every required criterion (including uncovered), and never equate preview coverage with production repair.
  verifications: defineTable(vVerification)
    .index("by_case", ["caseId"])
    .index("by_action", ["actionId"])
    .index("by_attempt", ["stepAttemptId"]),
  // Mutations must evaluate all conditionChecks and reject any matching notWhenCheck using fresh allowlisted facts (unknown facts fail closed), never grant authority from memory, and derive timesApplied/timesVerified as cached counts of distinct action outcomes (not check runs).
  recoveryMemories: defineTable(vRecoveryMemory)
    .index("by_app_and_signature", ["appId", "signature"])
    .index("by_source_case", ["sourceCaseId"]),
  // Mutations must check app/proposal ownership and never treat a preference as evidence or authorization.
  ownerPreferences: defineTable(vOwnerPreference).index("by_app", ["appId"]),
  // Mutations must verify the granting owner's authority, exact scope/parameters, current conditions and revision, expiry/revocation, and atomically limit lifetime executions to maxAttempts (positive integer, including failed/unknown executions; same-key retries count once).
  permissions: defineTable(vPermission).index("by_app", ["appId"]),
  // Mutations must check case/step/attempt/context ownership, reject stale callbacks, enforce lifecycle transitions, and evaluate only with evidence while keeping corrections separate.
  agentRuns: defineTable(vAgentRun)
    .index("by_case", ["caseId"])
    .index("by_attempt", ["stepAttemptId"]),
  // Mutations must enforce app ownership and source/revision freshness; retrieved context never authorizes execution.
  contextSources: defineTable(vContextSource)
    .index("by_app", ["appId"])
    .index("by_app_and_source", ["appId", "sourceRef"]),
  // The Investigate further chat about one case; a turtl message may point at the fix it added to a proposal.
  fixChatMessages: defineTable({
    caseId: v.id("cases"),
    role: v.union(v.literal("owner"), v.literal("turtl")),
    text: v.string(),
    at: v.number(),
    proposalId: v.optional(v.id("proposals")),
    optionKey: v.optional(v.string()),
  }).index("by_case", ["caseId"]),
  // Mutations must link a pull request to its case and the approved action; only the owner's Merge tap merges, with checks passing on the head they were shown.
  pullRequests: defineTable(vPullRequestRow)
    .index("by_case", ["caseId"])
    .index("by_action", ["actionId"])
    .index("by_settled", ["settledAt"]),
  bookingDemoSettings: defineTable({
    key: v.literal("demo"),
    recommendationsEnabled: v.boolean(),
    providerTimeout: v.boolean(),
    bookingStoreFailure: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  bookingDemoBookings: defineTable({
    serviceId: v.string(),
    date: v.string(),
    time: v.string(),
    createdAt: v.number(),
    fixtureRunId: v.optional(v.string()),
  }).index("by_fixture", ["fixtureRunId"]),
  bookingDemoAttempts: defineTable({
    serviceId: v.string(),
    date: v.string(),
    time: v.string(),
    timestamp: v.number(),
    status: v.union(v.literal("passed"), v.literal("failed")),
    revision: v.string(),
    error: v.optional(bookingError),
  }).index("by_timestamp", ["timestamp"]),
  ...revylTables,
  ...codeNetworkTables,
  ...externalAppTables,
});
