import { v } from "convex/values";
import type { Infer } from "convex/values";
import { agentRunRoutingFields } from "./routing/validators";

export const STAGES = [
  { id: "detect_or_receive", label: "Detect or receive a request" },
  { id: "gather_context", label: "Gather context" },
  { id: "investigate", label: "Investigate" },
  { id: "examine_broader_causes", label: "Examine broader causes" },
  { id: "plan", label: "Plan" },
  { id: "authorize_and_execute", label: "Authorize and execute" },
  { id: "verify", label: "Verify" },
  { id: "learn", label: "Learn" },
] as const;

export const STAGE_IDS = STAGES.map((stage) => stage.id);

export const EVIDENCE_STAGES = [
  { id: "collect_app_state", label: "Read app health, flags and revision" },
  { id: "collect_error_window", label: "Read the error window" },
] as const;

export const STEP_PURPOSE_IDS = [
  "detect_or_receive",
  ...EVIDENCE_STAGES.map((stage) => stage.id),
  ...STAGE_IDS.filter((id) => id !== "detect_or_receive"),
] as const;

export const CASE_STATUSES = [
  { id: "open", label: "Open" },
  { id: "investigating", label: "Investigating" },
  { id: "waiting_for_owner", label: "Waiting for you" },
  { id: "executing", label: "Executing" },
  { id: "waiting_for_deploy", label: "Waiting for deploy" },
  { id: "verifying", label: "Verifying" },
  { id: "restored", label: "Restored" },
  { id: "resolved", label: "Resolved" },
  { id: "unresolved", label: "Unresolved" },
  { id: "declined", label: "Declined" },
] as const;

export const CLOSED_CASE_STATUSES = ["resolved", "unresolved", "declined"] as const;

export const CASE_KINDS = [
  { id: "outage", label: "Outage" },
  { id: "bug_report", label: "Bug report" },
  { id: "feature_request", label: "Feature request" },
] as const;

export const RAISED_BY = ["monitor", "owner", "customer"] as const;

export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
] as const;

export const vStage = v.union(
  v.literal("detect_or_receive"),
  v.literal("collect_app_state"),
  v.literal("collect_error_window"),
  v.literal("gather_context"),
  v.literal("investigate"),
  v.literal("examine_broader_causes"),
  v.literal("plan"),
  v.literal("authorize_and_execute"),
  v.literal("verify"),
  v.literal("learn"),
);

export const vCaseStatus = v.union(
  v.literal("open"),
  v.literal("investigating"),
  v.literal("waiting_for_owner"),
  v.literal("executing"),
  v.literal("waiting_for_deploy"),
  v.literal("verifying"),
  v.literal("restored"),
  v.literal("resolved"),
  v.literal("unresolved"),
  v.literal("declined"),
);

export const vCaseKind = v.union(
  v.literal("outage"),
  v.literal("bug_report"),
  v.literal("feature_request"),
);

export const vRaisedBy = v.union(
  v.literal("monitor"),
  v.literal("owner"),
  v.literal("customer"),
);

export const STEP_KINDS = ["function", "agent", "approval"] as const;

export const ATTEMPT_STATUSES = ["running", "waiting", "done", "failed"] as const;

export const vStepKind = v.union(
  v.literal("function"),
  v.literal("agent"),
  v.literal("approval"),
);

export const vAttemptStatus = v.union(
  v.literal("running"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("failed"),
);

export const vStepStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("skipped"),
);

// A pointer from a step attempt's handoff to something it produced: a commit, an artifact, evidence, an open question.
export const vOutputRef = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
});

export type Stage = Infer<typeof vStage>;
export type CaseStatus = Infer<typeof vCaseStatus>;
export type CaseKind = Infer<typeof vCaseKind>;
export type RaisedBy = Infer<typeof vRaisedBy>;
export type StepStatus = Infer<typeof vStepStatus>;
export type StepKind = Infer<typeof vStepKind>;
export type AttemptStatus = Infer<typeof vAttemptStatus>;

export const vNoticeEvent = v.union(
  v.literal("opened"),
  v.literal("needs_decision"),
  v.literal("handled_under_permission"),
);

export const vNoticeOutcome = v.union(
  v.literal("ran"),
  v.literal("queued"),
  v.literal("unavailable"),
  v.literal("not_configured"),
  v.literal("failed"),
);

export const vOwnerNotice = v.object({
  caseId: v.id("cases"),
  event: vNoticeEvent,
  outcome: v.union(v.literal("pending"), vNoticeOutcome),
  status: v.optional(v.number()),
  observedAt: v.number(),
});

export const vActor = v.object({
  kind: v.union(
    v.literal("owner"),
    v.literal("auto"),
    v.literal("agent"),
    v.literal("service"),
  ),
  identity: v.string(),
});

export const vTarget = v.object({
  environment: v.string(),
  resourceRef: v.string(),
});

export const vRevision = v.union(
  v.object({
    commitSha: v.string(),
    buildId: v.optional(v.string()),
    deploymentId: v.optional(v.string()),
  }),
  v.object({
    commitSha: v.optional(v.string()),
    buildId: v.string(),
    deploymentId: v.optional(v.string()),
  }),
  v.object({
    commitSha: v.optional(v.string()),
    buildId: v.optional(v.string()),
    deploymentId: v.string(),
  }),
);

export const vParameterValue = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
);
export const vParameters = v.array(
  v.object({ name: v.string(), value: vParameterValue }),
);
export const vParameterConstraint = v.object({
  name: v.string(),
  type: v.union(
    v.literal("string"),
    v.literal("number"),
    v.literal("boolean"),
    v.literal("null"),
  ),
  required: v.boolean(),
  allowedValues: v.optional(v.array(vParameterValue)),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
});

export const vHttpMethod = v.union(
  v.literal("GET"),
  v.literal("POST"),
  v.literal("PUT"),
  v.literal("PATCH"),
  v.literal("DELETE"),
);
export const vCheck = v.union(
  v.object({
    kind: v.literal("http"),
    config: v.object({
      url: v.string(),
      method: vHttpMethod,
      expectedStatus: v.number(),
      credentialRef: v.optional(v.string()),
    }),
  }),
  v.object({
    kind: v.literal("revyl"),
    config: v.object({
      workflowId: v.string(),
      appId: v.optional(v.string()),
      credentialRef: v.optional(v.string()),
    }),
  }),
);

export const vActionConfig = v.union(
  v.object({
    kind: v.literal("http"),
    url: v.string(),
    method: vHttpMethod,
    credentialRef: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("capy"),
    repoUrl: v.string(),
    baseBranch: v.string(),
    credentialRef: v.optional(v.string()),
  }),
);

export const vCriterion = v.object({ id: v.string(), description: v.string() });
export const vCheckReference = v.object({
  journeyId: v.id("journeys"),
  version: v.string(),
});
export const vCondition = v.object({
  field: v.string(),
  operator: v.union(
    v.literal("eq"),
    v.literal("neq"),
    v.literal("lt"),
    v.literal("lte"),
    v.literal("gt"),
    v.literal("gte"),
  ),
  value: vParameterValue,
});

export const vJourney = v.object({
  appId: v.id("apps"),
  name: v.string(),
  description: v.string(),
  check: vCheck,
  checkVersion: v.string(),
  lastPassedAt: v.optional(v.number()),
  // Since when it has passed every time it was checked: set by a pass when unset, cleared by anything else (a failure, or
  // no answer). A case records how long it had been passing (cases.passingForMs) for the outage reserve.
  passingSince: v.optional(v.number()),
  // Set on a prevention check registered from a structural finding (convex/structural).
  preventionFindingId: v.optional(v.id("structuralFindings")),
});

export const vActionCatalogEntry = v.object({
  appId: v.id("apps"),
  type: v.string(),
  name: v.string(),
  description: v.string(),
  reversible: v.boolean(),
  config: vActionConfig,
  parameterConstraints: v.array(vParameterConstraint),
});

export const vReport = v.object({
  appId: v.id("apps"),
  caseId: v.optional(v.id("cases")),
  channel: v.union(v.literal("text"), v.literal("form"), v.literal("email")),
  fromRef: v.string(),
  text: v.string(),
  provider: v.string(),
  providerEventId: v.string(),
  receivedAt: v.number(),
});

export const vEvidence = v.object({
  caseId: v.id("cases"),
  stepId: v.id("steps"),
  stepAttemptId: v.id("stepAttempts"),
  kind: v.string(),
  title: v.string(),
  body: v.optional(v.string()),
  url: v.optional(v.string()),
  sourceRef: v.optional(v.string()),
  // Set on a gather step's copy of evidence an earlier step recorded: the original row. Screens show the original once.
  copyOf: v.optional(v.id("evidence")),
  observedAt: v.number(),
  environment: v.string(),
  revision: vRevision,
});

export const vOptionKind = v.union(
  v.literal("recovery"),
  v.literal("repair"),
  v.literal("prevention"),
  v.literal("change"),
);
// A run of plain words; `cite` names an evidence id the words rest on.
export const vSpan = v.object({ text: v.string(), cite: v.optional(v.string()) });
// How an approved option reaches the app: a catalog action run by turtl, or a pull request the owner merges.
export const vDelivery = v.union(v.literal("action"), v.literal("pull_request"));
export const vProposalOption = v.object({
  key: v.string(),
  title: v.string(),
  kind: vOptionKind,
  actionType: v.string(),
  actionCatalogId: v.id("actionCatalog"),
  target: vTarget,
  parameters: vParameters,
  acceptanceCriteria: v.array(vCriterion),
  checkRefs: v.array(vCheckReference),
  usersCantNow: v.optional(v.string()),
  whatChanges: v.string(),
  whatMightBeLost: v.string(),
  howChecked: v.string(),
  evidenceIds: v.array(v.id("evidence")),
  recommended: v.boolean(),
  confidence: v.number(),
  why: v.optional(v.array(vSpan)),
  delivery: v.optional(vDelivery),
  codeIds: v.optional(v.array(v.string())),
  proposedInChat: v.optional(v.boolean()),
  preferences: v.optional(v.array(v.object({ preferenceId: v.id("ownerPreferences"), statement: v.string() }))),
  pastDecisions: v.optional(v.string()),
  contextIds: v.optional(v.array(v.id("contextUses"))),
});

export const vDecisionStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
);
export const vProposal = v.object({
  caseId: v.id("cases"),
  stepId: v.id("steps"),
  version: v.number(),
  decisionStatus: vDecisionStatus,
  options: v.array(vProposalOption),
  doneMeans: v.array(vCriterion),
  chosenKey: v.optional(v.string()),
  chosenBy: v.optional(vActor),
  decidedAt: v.optional(v.number()),
  ownerNote: v.optional(v.string()),
});

export const vExecutionPayload = v.object({
  actionCatalogId: v.id("actionCatalog"),
  type: v.string(),
  target: vTarget,
  parameters: vParameters,
  config: vActionConfig,
  acceptanceCriteria: v.array(vCriterion),
  checkRefs: v.array(vCheckReference),
});

export const vActionStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("unknown"),
);
export const vAction = v.object({
  caseId: v.id("cases"),
  proposalId: v.id("proposals"),
  approvedProposalVersion: v.number(),
  optionKey: v.string(),
  type: v.string(),
  requestedBy: v.union(v.literal("owner"), v.literal("auto")),
  actor: vActor,
  environment: v.string(),
  revision: vRevision,
  executionPayload: vExecutionPayload,
  permissionId: v.optional(v.id("permissions")),
  status: vActionStatus,
  result: v.optional(v.string()),
  idempotencyKey: v.string(),
  externalRef: v.optional(v.string()),
  requestedAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  cancelledBy: v.optional(vActor),
  cancelledAt: v.optional(v.number()),
});

export const vVerificationPhase = v.union(
  v.literal("before"),
  v.literal("after_fix"),
  v.literal("after_deploy"),
);
export const vVerificationVerdict = v.union(
  v.literal("passed"),
  v.literal("failed"),
  v.literal("inconclusive"),
);
export const vCriterionResult = v.object({
  criterionId: v.string(),
  status: v.union(
    v.literal("passed"),
    v.literal("failed"),
    v.literal("uncovered"),
  ),
  summary: v.string(),
  evidenceIds: v.array(v.id("evidence")),
});
export const vVerification = v.object({
  caseId: v.id("cases"),
  journeyId: v.optional(v.id("journeys")),
  actionId: v.optional(v.id("actions")),
  stepAttemptId: v.id("stepAttempts"),
  phase: vVerificationPhase,
  environment: v.string(),
  revision: vRevision,
  checkVersion: v.string(),
  criteriaVersion: v.string(),
  criterionResults: v.array(vCriterionResult),
  evidenceIds: v.array(v.id("evidence")),
  startedAt: v.number(),
  completedAt: v.number(),
  verdict: vVerificationVerdict,
  coverage: v.object({
    coveredCriterionIds: v.array(v.string()),
    uncoveredCriterionIds: v.array(v.string()),
  }),
  confidence: v.optional(v.number()),
  summary: v.string(),
  recordingUrl: v.optional(v.string()),
});

export const vRecoveryMemory = v.object({
  appId: v.id("apps"),
  sourceCaseId: v.id("cases"),
  signature: v.string(),
  symptoms: v.string(),
  conditions: v.array(v.string()),
  conditionChecks: v.array(vCondition),
  cause: v.string(),
  conditionSource: v.optional(v.union(v.literal("diagnosis"), v.literal("fallback"))),
  criterionResults: v.optional(v.array(vCriterionResult)),
  actionType: v.string(),
  verificationId: v.id("verifications"),
  notWhen: v.array(v.string()),
  notWhenChecks: v.array(vCondition),
  appRevision: v.optional(v.string()),
  timesApplied: v.number(),
  timesVerified: v.number(),
  supermemoryId: v.optional(v.string()),
  invalidatedAt: v.optional(v.number()),
});

export const vOwnerPreference = v.object({
  appId: v.id("apps"),
  statement: v.string(),
  sourceProposalId: v.optional(v.id("proposals")),
  supermemoryId: v.optional(v.string()),
  source: v.optional(v.union(v.literal("settings"), v.literal("chat"), v.literal("decision_note"))),
  sourceCaseId: v.optional(v.id("cases")),
});

export const vPermission = v.object({
  appId: v.id("apps"),
  memoryId: v.optional(v.id("recoveryMemories")),
  actionType: v.string(),
  grantedBy: vActor,
  grantedAt: v.number(),
  scope: vTarget,
  parameterConstraints: v.array(vParameterConstraint),
  conditions: v.array(v.string()),
  conditionChecks: v.array(vCondition),
  notWhen: v.array(v.string()),
  notWhenChecks: v.array(vCondition),
  maxAttempts: v.number(),
  grantedAtRevision: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
  endedReason: v.optional(v.string()),
});

export const vAgentRunStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);
export const vAgentEvaluation = v.object({
  verdict: v.union(
    v.literal("verified"),
    v.literal("failed"),
    v.literal("infra_failure"),
  ),
  verificationIds: v.array(v.id("verifications")),
  evaluatedAt: v.number(),
});
export const vAgentRun = v.object({
  stepId: v.optional(v.id("steps")),
  caseId: v.optional(v.id("cases")),
  appId: v.optional(v.id("apps")),
  stepAttemptId: v.optional(v.id("stepAttempts")),
  taskType: v.string(),
  config: v.object({
    modelId: v.string(),
    reasoning: v.optional(v.string()),
    tools: v.optional(v.array(v.string())),
    harnessVersion: v.string(),
    promptVersion: v.string(),
    credentialRef: v.optional(v.string()),
  }),
  taskCharacteristics: v.object({
    complexity: v.string(),
    risk: v.string(),
    framework: v.string(),
    repositoryArea: v.string(),
  }),
  contextRefs: v.array(v.id("contextSources")),
  routingReason: v.string(),
  routingPolicyVersion: v.optional(v.string()),
  status: vAgentRunStatus,
  error: v.optional(v.string()),
  evaluation: v.optional(vAgentEvaluation),
  corrections: v.array(
    v.object({
      description: v.string(),
      correctedAt: v.number(),
      actor: vActor,
      evidenceIds: v.array(v.id("evidence")),
    }),
  ),
  costUsd: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  ...agentRunRoutingFields,
});

export const vContextSource = v.object({
  appId: v.id("apps"),
  kind: v.union(
    v.literal("code"),
    v.literal("document"),
    v.literal("architecture"),
    v.literal("decision"),
    v.literal("past_case"),
    v.literal("memory"),
  ),
  sourceRef: v.string(),
  revision: v.optional(v.string()),
  indexedAt: v.number(),
  supermemoryId: v.optional(v.string()),
  invalidatedAt: v.optional(v.number()),
  label: v.optional(v.string()),
  timesSupplied: v.optional(v.number()),
  timesUsed: v.optional(v.number()),
  timesHelped: v.optional(v.number()),
  lastHelpedAt: v.optional(v.number()),
});

export type Actor = Infer<typeof vActor>;
export type Target = Infer<typeof vTarget>;
export type Revision = Infer<typeof vRevision>;
export type Parameters = Infer<typeof vParameters>;
export type ParameterValue = Infer<typeof vParameterValue>;
export type ParameterConstraint = Infer<typeof vParameterConstraint>;
export type HttpMethod = Infer<typeof vHttpMethod>;
export type Check = Infer<typeof vCheck>;
export type ActionConfig = Infer<typeof vActionConfig>;
export type Criterion = Infer<typeof vCriterion>;
export type CheckReference = Infer<typeof vCheckReference>;
export type Condition = Infer<typeof vCondition>;
export type Journey = Infer<typeof vJourney>;
export type ActionCatalogEntry = Infer<typeof vActionCatalogEntry>;
export type Report = Infer<typeof vReport>;
export type Evidence = Infer<typeof vEvidence>;
export type ProposalOption = Infer<typeof vProposalOption>;
export type Span = Infer<typeof vSpan>;
export type Delivery = Infer<typeof vDelivery>;
export type OptionKind = Infer<typeof vOptionKind>;
export type DecisionStatus = Infer<typeof vDecisionStatus>;
export type Proposal = Infer<typeof vProposal>;
export type ExecutionPayload = Infer<typeof vExecutionPayload>;
export type ActionStatus = Infer<typeof vActionStatus>;
export type Action = Infer<typeof vAction>;
export type VerificationPhase = Infer<typeof vVerificationPhase>;
export type VerificationVerdict = Infer<typeof vVerificationVerdict>;
export type CriterionResult = Infer<typeof vCriterionResult>;
export type Verification = Infer<typeof vVerification>;
export type RecoveryMemory = Infer<typeof vRecoveryMemory>;
export type OwnerPreference = Infer<typeof vOwnerPreference>;
export type Permission = Infer<typeof vPermission>;
export type AgentRunStatus = Infer<typeof vAgentRunStatus>;
export type AgentEvaluation = Infer<typeof vAgentEvaluation>;
export type AgentRun = Infer<typeof vAgentRun>;
export type ContextSource = Infer<typeof vContextSource>;
export type OutputRef = Infer<typeof vOutputRef>;

// Words for the owner when a service turtl uses is not connected on this backend. They land in step summaries and
// reasons a case shows, so they never name a setting: the operator finds those in convex/README and the logs.
export const NO_MODEL_REASON = "no AI model is connected to turtl yet, so none was asked";
export const NO_SUPERMEMORY = "Supermemory is not connected to turtl";
/** A flag's name as the owner says it: "recommendationsEnabled" is "recommendations". */
export function settingName(flag: string): string {
  return flag.replace(/(Enabled|_enabled|Flag)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ").toLowerCase().trim() || flag;
}
/** For a step that stopped on a thrown error: what the owner reads. The error itself goes to the backend's log. */
export const UNEXPECTED_STOP = "This step stopped on an unexpected problem, so turtl could not finish it.";
