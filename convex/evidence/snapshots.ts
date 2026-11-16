import type { Id } from "../_generated/dataModel";
import type { Revision } from "../constants";
import type { HandlerInput } from "../runner/contract";
import type { Facts, JourneyContext } from "../runner/handlers/journey";

export type Collector = "collect_app_state" | "collect_error_window";
export type ObservedWindow = { since: number; until: number; truncated: boolean; sampleLimit?: number };
export type SnapshotEvidence = {
  id: Id<"evidence">;
  kind: string;
  sourceRef: string;
  observedAt: number;
  environment: string;
  revision: Revision;
};
export type EvidenceSnapshot = {
  version: 1;
  collector: Collector;
  caseId: Id<"cases">;
  stepId: Id<"steps">;
  attemptId: Id<"stepAttempts">;
  facts: Facts;
  missing: string[];
  revision: Revision;
  evidence: SnapshotEvidence[];
  window?: ObservedWindow;
};
export type AppEvidence = {
  facts: Facts;
  missing: string[];
  revision: Revision;
  refs: { kind: "evidence"; id: Id<"evidence">; label: string }[];
  readCount: number;
  sourceCount: 4;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object.");
  return value as Record<string, unknown>;
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => time(value) && Number.isSafeInteger(value);

function sourceMetadata(raw: Record<string, unknown>) {
  for (const key of ["environment", "revision"]) {
    requireValue(raw[key] === undefined || text(raw[key]), `Invalid source ${key}.`);
  }
}

export function validateHealth(value: unknown): { ok: boolean; environment?: string; revision?: string } {
  const raw = object(value);
  requireValue(typeof raw.ok === "boolean", "Health must report a boolean ok.");
  requireValue(raw.timestamp === undefined || time(raw.timestamp), "Invalid health timestamp.");
  requireValue(raw.service === undefined || text(raw.service), "Invalid health service.");
  sourceMetadata(raw);
  return { ok: raw.ok, ...(raw.environment !== undefined && { environment: raw.environment as string }), ...(raw.revision !== undefined && { revision: raw.revision as string }) };
}

export function validateFlags(value: unknown): { recommendationsEnabled: boolean; environment?: string; revision?: string } {
  const raw = object(value);
  requireValue(typeof raw.recommendationsEnabled === "boolean", "Flags must report a boolean recommendationsEnabled.");
  requireValue(raw.updatedAt === undefined || time(raw.updatedAt), "Invalid flags timestamp.");
  sourceMetadata(raw);
  return { recommendationsEnabled: raw.recommendationsEnabled, ...(raw.environment !== undefined && { environment: raw.environment as string }), ...(raw.revision !== undefined && { revision: raw.revision as string }) };
}

export function validateRevisionResponse(value: unknown): { revision: string; environment?: string } {
  const raw = object(value);
  requireValue(text(raw.revision), "Revision must report a non-empty revision.");
  sourceMetadata(raw);
  return { revision: raw.revision, ...(raw.environment !== undefined && { environment: raw.environment as string }) };
}

export function validateWindow(value: unknown): ObservedWindow {
  const raw = object(value);
  requireValue(time(raw.since) && time(raw.until) && raw.since <= raw.until, "Invalid error window bounds.");
  requireValue(typeof raw.truncated === "boolean", "Error window must report truncated.");
  requireValue(raw.sampleLimit === undefined || (count(raw.sampleLimit) && raw.sampleLimit > 0), "Invalid error sample limit.");
  return { since: raw.since, until: raw.until, truncated: raw.truncated, ...(raw.sampleLimit !== undefined && { sampleLimit: raw.sampleLimit as number }) };
}

function validateCounts(total: unknown, failed: unknown, rate: unknown) {
  requireValue(count(total) && count(failed) && failed <= total, "Invalid booking counts.");
  requireValue(typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1, "Invalid booking error rate.");
  requireValue(rate === (total ? failed / total : 0), "Booking error rate does not match counts.");
}

export function validateErrors(value: unknown) {
  const raw = object(value);
  const window = validateWindow(raw.window);
  const counts = object(raw.counts);
  validateCounts(counts.totalBookings, counts.failedBookings, counts.errorRate);
  requireValue(count(counts.successfulBookings) && counts.successfulBookings === (counts.totalBookings as number) - (counts.failedBookings as number), "Successful booking count does not match total.");
  if (window.sampleLimit !== undefined) {
    requireValue((counts.totalBookings as number) <= window.sampleLimit, "Booking count exceeds the sample limit.");
    requireValue(!window.truncated || counts.totalBookings === window.sampleLimit, "Truncated window does not fill its sample limit.");
  }
  requireValue(Array.isArray(raw.errors), "Errors must be an array.");
  requireValue(raw.errors.length <= (counts.failedBookings as number) && (counts.failedBookings === 0 || raw.errors.length > 0), "Error sample does not match failed booking count.");
  const errors = raw.errors.map((entry) => {
    const error = object(entry);
    requireValue(text(error.code) && error.code !== "none" && text(error.step), "Each error must report a code and step.");
    requireValue(time(error.timestamp) && error.timestamp >= window.since && error.timestamp <= window.until, "Error timestamp is outside its window.");
    for (const key of ["id", "message", "provider", "revision"]) {
      requireValue(error[key] === undefined || text(error[key]), `Invalid error ${key}.`);
    }
    requireValue(error.retryable === undefined || typeof error.retryable === "boolean", "Invalid error retryable value.");
    return { code: error.code, step: error.step, timestamp: error.timestamp };
  });
  sourceMetadata(raw);
  return {
    window,
    counts: { totalBookings: counts.totalBookings as number, failedBookings: counts.failedBookings as number, successfulBookings: counts.successfulBookings, errorRate: counts.errorRate as number },
    errors,
    ...(raw.environment !== undefined && { environment: raw.environment as string }),
    ...(raw.revision !== undefined && { revision: raw.revision as string }),
  };
}

export function validateRevision(value: unknown): Revision {
  const raw = object(value);
  const keys = Object.keys(raw);
  requireValue(keys.length > 0 && keys.every((key) => ["commitSha", "buildId", "deploymentId"].includes(key) && text(raw[key])), "Invalid evidence revision.");
  requireValue(text(raw.deploymentId), "Evidence revision must identify its source deployment.");
  requireValue(raw.commitSha === undefined || /^[0-9a-f]{7,40}$/i.test(raw.commitSha as string), "Invalid evidence commit SHA.");
  return raw as Revision;
}

function sameRevision(a: Revision, b: Revision) {
  return a.commitSha === b.commitSha && a.buildId === b.buildId && a.deploymentId === b.deploymentId;
}

const sources = {
  collect_app_state: [["health", "GET /health"], ["flags", "GET /flags"], ["revision", "GET /revision"]],
  collect_error_window: [["errors", "GET /errors"]],
} as const;

export function validateSnapshot(value: unknown, collector: Collector): EvidenceSnapshot {
  const raw = object(value);
  requireValue(raw.version === 1 && raw.collector === collector, "Unexpected evidence snapshot version or collector.");
  requireValue(text(raw.caseId) && text(raw.stepId) && text(raw.attemptId), "Snapshot is missing its case, step or attempt ID.");
  requireValue(Array.isArray(raw.missing) && raw.missing.length === 0, "Successful snapshot contains missing reads.");
  const facts = object(raw.facts);
  const expected = collector === "collect_app_state"
    ? ["health.ok", "flags.recommendationsEnabled", "app.revision"]
    : ["errors.totalBookings", "errors.failedBookings", "errors.errorRate", "errors.topCode"];
  requireValue(Object.keys(facts).length === expected.length && expected.every((key) => Object.hasOwn(facts, key)), "Snapshot has missing or unexpected facts.");
  if (collector === "collect_app_state") {
    requireValue(typeof facts["health.ok"] === "boolean" && typeof facts["flags.recommendationsEnabled"] === "boolean" && text(facts["app.revision"]), "Invalid app-state facts.");
    requireValue(raw.window === undefined, "App-state snapshot contains an error window.");
  } else {
    validateCounts(facts["errors.totalBookings"], facts["errors.failedBookings"], facts["errors.errorRate"]);
    requireValue(text(facts["errors.topCode"]) && ((facts["errors.failedBookings"] === 0) === (facts["errors.topCode"] === "none")), "Invalid top error code.");
    const window = validateWindow(raw.window);
    if (window.sampleLimit !== undefined) {
      requireValue((facts["errors.totalBookings"] as number) <= window.sampleLimit && (!window.truncated || facts["errors.totalBookings"] === window.sampleLimit), "Snapshot counts do not match its sample limit.");
    }
  }
  const revision = validateRevision(raw.revision);
  if (collector === "collect_app_state") {
    requireValue((revision.commitSha ?? revision.buildId) === facts["app.revision"], "Snapshot revision does not match the observed app revision.");
  }
  requireValue(Array.isArray(raw.evidence) && raw.evidence.length === sources[collector].length, "Snapshot has missing or unexpected evidence.");
  const ids = new Set<string>();
  const kinds = new Set<string>();
  for (const entry of raw.evidence) {
    const evidence = object(entry);
    requireValue(text(evidence.id) && !ids.has(evidence.id), "Invalid or duplicate evidence ID.");
    requireValue(text(evidence.kind) && !kinds.has(evidence.kind) && sources[collector].some(([kind, sourceRef]) => evidence.kind === kind && evidence.sourceRef === sourceRef), "Snapshot evidence has the wrong source role.");
    requireValue(time(evidence.observedAt) && text(evidence.environment), "Invalid evidence time or environment.");
    const sourceRevision = validateRevision(evidence.revision);
    if (evidence.kind === (collector === "collect_app_state" ? "revision" : "errors")) {
      requireValue(sameRevision(sourceRevision, revision), "Snapshot revision differs from its source evidence.");
    }
    ids.add(evidence.id);
    kinds.add(evidence.kind);
  }
  return raw as EvidenceSnapshot;
}

export function joinSnapshots(input: HandlerInput, context: Pick<JourneyContext, "evidence">): AppEvidence {
  const roles: Collector[] = ["collect_app_state", "collect_error_window"];
  requireValue(input.step.purpose === "gather_context" && input.step.key === "gather_context" && input.step.kind === "function", "Only the gather_context function can consume evidence snapshots.");
  requireValue(input.step.caseId === input.case._id && input.attempt.caseId === input.case._id && input.attempt.stepId === input.step._id, "Join attempt does not belong to this case and step.");
  requireValue(input.parents.length === 2 && input.step.dependsOn.length === 2 && roles.every((role) => input.step.dependsOn.includes(role)), "Join must depend on both collectors exactly once.");
  const pinned = input.attempt.inputRefs;
  requireValue(pinned?.length === 2 && new Set(pinned).size === 2, "Join must pin both consumed collector attempts.");
  const snapshots = roles.map((role) => {
    const parents = input.parents.filter(({ step }) => step.key === role && step.purpose === role);
    requireValue(parents.length === 1, "Join is missing a collector or has a wrong-role parent.");
    const { step, attempt } = parents[0];
    requireValue(step.caseId === input.case._id && step.kind === "function" && step.status === "done", "Collector parent is not a completed function in this case.");
    requireValue(attempt && attempt.status === "done" && pinned.includes(attempt._id), "Collector attempt was not completed and pinned by this join.");
    requireValue(attempt.caseId === input.case._id && attempt.stepId === step._id, "Collector attempt belongs to another case or step.");
    const snapshot = validateSnapshot(attempt.output, role);
    requireValue(snapshot.caseId === input.case._id && snapshot.stepId === step._id && snapshot.attemptId === attempt._id, "Snapshot IDs differ from the consumed parent attempt.");
    for (const entry of snapshot.evidence) {
      const rows = context.evidence.filter((row) => row._id === entry.id);
      requireValue(rows.length === 1, "Snapshot evidence was not recorded in this case.");
      const row = rows[0];
      requireValue(row.caseId === snapshot.caseId && row.stepId === snapshot.stepId && row.stepAttemptId === snapshot.attemptId, "Evidence does not belong to the consumed collector attempt.");
      requireValue(row.kind === entry.kind && row.sourceRef === entry.sourceRef && row.observedAt === entry.observedAt && row.environment === entry.environment && sameRevision(validateRevision(row.revision), entry.revision), "Snapshot evidence provenance differs from its recorded row.");
    }
    return snapshot;
  });
  requireValue(new Set(snapshots.map((snapshot) => snapshot.attemptId)).size === 2 && new Set(snapshots.map((snapshot) => snapshot.stepId)).size === 2, "Collectors must have distinct steps and attempts.");
  const environment = snapshots[0].evidence[0].environment;
  const deploymentId = snapshots[0].revision.deploymentId;
  const appRevision = snapshots[0].facts["app.revision"];
  for (const entry of snapshots.flatMap((snapshot) => snapshot.evidence)) {
    requireValue(entry.environment === environment, "Consumed evidence has conflicting source environments.");
    requireValue(entry.revision.deploymentId === deploymentId, "Consumed evidence has conflicting source deployments.");
    requireValue([entry.revision.commitSha, entry.revision.buildId].every((revision) => revision === undefined || revision === appRevision), "Consumed evidence has a source revision that conflicts with app.revision.");
  }
  return {
    facts: { ...snapshots[0].facts, ...snapshots[1].facts },
    missing: [],
    revision: snapshots[0].revision,
    refs: snapshots.flatMap((snapshot) => snapshot.evidence.map(({ id, kind }) => ({ kind: "evidence" as const, id, label: kind }))),
    readCount: 4,
    sourceCount: 4,
  };
}
