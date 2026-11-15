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

export const INCIDENT_STATUSES = ["open", "resolved", "failed"] as const;

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

export const vIncidentStatus = v.union(
  v.literal("open"),
  v.literal("resolved"),
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
export type IncidentStatus = Infer<typeof vIncidentStatus>;
export type StepStatus = Infer<typeof vStepStatus>;
