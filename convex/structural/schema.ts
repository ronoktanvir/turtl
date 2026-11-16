import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

// A structural finding: one examination's hypothesis about a deeper cause across related cases, with the
// records that support it, a bounded change, and a test that could disprove it. Only complete findings are
// stored here; an incomplete reply stays a note on the step attempt.

export const vFindingRef = v.object({
  kind: v.union(
    v.literal("case"),
    v.literal("evidence"),
    v.literal("verification"),
    v.literal("recoveryMemory"),
    v.literal("action"),
    v.literal("codeNode"),
  ),
  id: v.string(),
  label: v.string(),
});

export const vFindingEvidence = v.object({ ref: vFindingRef, says: v.string() });

export const vFindingChange = v.object({
  title: v.string(),
  kind: v.union(v.literal("repair"), v.literal("prevention")),
  whatChanges: v.string(),
  whatMightBeLost: v.string(),
  scope: v.array(v.string()),
  change: v.string(),
});

export const vFindingTest = v.object({
  description: v.string(),
  expectedIfTrue: v.string(),
  disprovedIf: v.string(),
  scenario: v.optional(v.string()),
});

export const vCheckRun = v.object({
  verdict: v.union(v.literal("passed"), v.literal("failed")),
  failedStep: v.optional(v.string()),
  summary: v.string(),
  at: v.number(),
});

// The prevention check offered with a finding. offered: waiting on the owner. running: approved, its one
// fresh run is in flight. registered: a journeys row exists and the monitor runs it. not_registered: the
// fresh run returned no result, so nothing was registered.
export const vPreventionCheck = v.object({
  scenario: v.string(),
  name: v.string(),
  description: v.string(),
  url: v.string(),
  credentialRef: v.optional(v.string()),
  status: v.union(
    v.literal("offered"),
    v.literal("running"),
    v.literal("registered"),
    v.literal("not_registered"),
  ),
  approvedAt: v.optional(v.number()),
  journeyId: v.optional(v.id("journeys")),
  freshRun: v.optional(vCheckRun),
  reason: v.optional(v.string()),
});

export const vFinding = v.object({
  appId: v.id("apps"),
  caseId: v.id("cases"),
  stepAttemptId: v.id("stepAttempts"),
  agentRunId: v.id("agentRuns"),
  hypothesis: v.string(),
  evidence: v.array(vFindingEvidence),
  change: vFindingChange,
  test: vFindingTest,
  confidence: v.number(),
  connectedCaseIds: v.array(v.id("cases")),
  seededCaseCount: v.number(),
  proposalId: v.optional(v.id("proposals")),
  optionKey: v.optional(v.string()),
  fixNote: v.optional(v.string()),
  check: v.optional(vPreventionCheck),
  foundAt: v.number(),
});

export type FindingRef = Infer<typeof vFindingRef>;
export type FindingEvidence = Infer<typeof vFindingEvidence>;
export type FindingChange = Infer<typeof vFindingChange>;
export type FindingTest = Infer<typeof vFindingTest>;
export type Finding = Infer<typeof vFinding>;

export const structuralTables = {
  structuralFindings: defineTable(vFinding)
    .index("by_app", ["appId"])
    .index("by_case", ["caseId"]),
};
