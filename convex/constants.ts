import { v } from "convex/values";
import type { Infer } from "convex/values";

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

export type Stage = Infer<typeof vStage>;
export type CaseStatus = Infer<typeof vCaseStatus>;
export type CaseKind = Infer<typeof vCaseKind>;
export type RaisedBy = Infer<typeof vRaisedBy>;
export type StepStatus = Infer<typeof vStepStatus>;
export type StepKind = Infer<typeof vStepKind>;
export type AttemptStatus = Infer<typeof vAttemptStatus>;
