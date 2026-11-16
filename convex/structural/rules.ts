// Pure rules for the structural step: which earlier cases count as related history, whether that history is
// enough to examine, which checks the monitor can run, and whether a model's reply is a complete finding.
// No Convex imports, so tests can load this file directly.

export const MIN_RELATED_CASES = 2;
export const MAX_SCOPE_AREAS = 3;
export const MAX_CHANGE_LENGTH = 1500;
export const MIN_EVIDENCE_REFS = 2;

const NO_COMPONENT = new Set(["", "none", "unknown"]);

export type HistoryCase = {
  id: string;
  title: string;
  createdAt: number;
  signature?: string;
  failedStep?: string;
  memoryIds: string[];
  verifiedRecovery: boolean;
  isSample: boolean;
};

export type RelatedReason = "signature" | "component" | "cause";
export type RelatedCase<T extends HistoryCase = HistoryCase> = T & { reasons: RelatedReason[] };

// Earlier cases of the same app that share this case's signature, its failing component (the journey step
// that failed), or a recorded cause (a recovery memory one matched or learned and the other matched).
export function relatedCases<T extends HistoryCase>(current: HistoryCase, history: T[]): RelatedCase<T>[] {
  const related: RelatedCase<T>[] = [];
  for (const other of history) {
    if (other.id === current.id || other.createdAt >= current.createdAt) continue;
    const reasons: RelatedReason[] = [];
    if (current.signature && other.signature === current.signature) reasons.push("signature");
    if (current.failedStep && !NO_COMPONENT.has(current.failedStep) && other.failedStep === current.failedStep) {
      reasons.push("component");
    }
    if (current.memoryIds.some((id) => other.memoryIds.includes(id))) reasons.push("cause");
    if (reasons.length) related.push({ ...other, reasons });
  }
  return related.sort((a, b) => a.createdAt - b.createdAt);
}

export type Trigger<T extends HistoryCase = HistoryCase> =
  | { examine: true; reason: "related_history" | "recurrence"; related: RelatedCase<T>[]; summary: string }
  | { examine: false; related: RelatedCase<T>[]; summary: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Examine only with at least two related cases, or when the same component or cause comes back after a
// recovery that was verified. Everything else finishes without a model call.
export function shouldExamine<T extends HistoryCase>(current: HistoryCase, history: T[]): Trigger<T> {
  const related = relatedCases(current, history);
  const seeded = related.filter((c) => c.isSample).length;
  const recurrence = related.find(
    (c) => c.verifiedRecovery && (c.reasons.includes("component") || c.reasons.includes("cause")),
  );
  if (related.length >= MIN_RELATED_CASES) {
    return {
      examine: true,
      reason: "related_history",
      related,
      summary: `${plural(related.length, "related case")} on this app.${seeded ? ` ${seeded} of them ${seeded === 1 ? "is a seeded sample" : "are seeded samples"}.` : ""}`,
    };
  }
  if (recurrence) {
    return {
      examine: true,
      reason: "recurrence",
      related,
      summary: `This came back after a verified recovery in an earlier case (${recurrence.title}).${recurrence.isSample ? " That case is a seeded sample." : ""}`,
    };
  }
  if (!related.length) return { examine: false, related, summary: "Not examined: no related cases." };
  return {
    examine: false,
    related,
    summary: `Not examined: ${plural(related.length, "related case")}, and turtl looks for a broader cause only after ${MIN_RELATED_CASES} related cases or a recurrence after a verified recovery.`,
  };
}

// Checks the monitor can run besides a journey's own: a variant of an HTTP journey check that the protected
// app runs with one dependency degraded for that run only. The app must echo the scenario in its result.
export const CHECK_SCENARIOS = {
  slow_recommendations: {
    name: "Book while recommendations are slow",
    description:
      "Runs the booking journey with the app's live settings, but with the recommendations provider slowed past its time limit for this one run. It fails while a slow provider would stop customers from booking.",
  },
} as const;

export type ScenarioId = keyof typeof CHECK_SCENARIOS;

export const isScenario = (value: unknown): value is ScenarioId =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(CHECK_SCENARIOS, value);

// The scenario check's URL for a journey check URL, or null when that journey cannot run scenarios.
export function scenarioUrl(journeyCheckUrl: string, scenario: ScenarioId): string | null {
  let url: URL;
  try {
    url = new URL(journeyCheckUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/journey-check") || url.search) return null;
  url.searchParams.set("scenario", scenario);
  return url.toString();
}

export type KnownRecord = { kind: "case" | "evidence" | "verification" | "recoveryMemory" | "action" | "codeNode"; label: string; caseId?: string };

export type ReadFinding =
  | {
      ok: true;
      hypothesis: string;
      evidence: { ref: { kind: KnownRecord["kind"]; id: string; label: string }; says: string }[];
      change: { title: string; kind: "repair" | "prevention"; whatChanges: string; whatMightBeLost: string; scope: string[]; change: string };
      test: { description: string; expectedIfTrue: string; disprovedIf: string; scenario?: ScenarioId };
      confidence: number;
      connectedCaseIds: string[];
    }
  | { ok: false; missing: string[] };

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// A finding has four parts or it is not a recommendation: a concrete hypothesis, evidence that names real
// records (from at least two cases), a bounded change, and a test that could disprove it.
export function readFinding(
  raw: unknown,
  known: Map<string, KnownRecord>,
  scenarios: ScenarioId[] = [],
): ReadFinding {
  const reply = obj(raw);
  const missing: string[] = [];

  const hypothesis = str(reply.hypothesis);
  if (hypothesis.length < 20) missing.push("a concrete hypothesis");

  const evidence: { ref: { kind: KnownRecord["kind"]; id: string; label: string }; says: string }[] = [];
  const cases = new Set<string>();
  for (const item of Array.isArray(reply.evidence) ? reply.evidence : []) {
    const entry = obj(item);
    const id = str(entry.ref);
    const record = known.get(id);
    const says = str(entry.says);
    if (!record || !says || evidence.some((e) => e.ref.id === id)) continue;
    evidence.push({ ref: { kind: record.kind, id, label: record.label }, says });
    const caseId = record.kind === "case" ? id : record.caseId;
    if (caseId) cases.add(caseId);
  }
  if (evidence.length < MIN_EVIDENCE_REFS || cases.size < 2) {
    missing.push(`evidence that names at least ${MIN_EVIDENCE_REFS} real records from at least two cases`);
  }

  const rawChange = obj(reply.change);
  const kind = rawChange.kind === "repair" || rawChange.kind === "prevention" ? rawChange.kind : null;
  const scope = (Array.isArray(rawChange.scope) ? rawChange.scope : []).map(str).filter(Boolean);
  const change = {
    title: str(rawChange.title).slice(0, 80),
    whatChanges: str(rawChange.whatChanges),
    whatMightBeLost: str(rawChange.whatMightBeLost),
    change: str(rawChange.change),
  };
  if (
    !kind ||
    !change.title ||
    !change.whatChanges ||
    !change.whatMightBeLost ||
    !change.change ||
    change.change.length > MAX_CHANGE_LENGTH ||
    scope.length === 0 ||
    scope.length > MAX_SCOPE_AREAS
  ) {
    missing.push(`a bounded change (a repair or prevention in at most ${MAX_SCOPE_AREAS} named areas)`);
  }

  const rawTest = obj(reply.test);
  const test = {
    description: str(rawTest.description),
    expectedIfTrue: str(rawTest.expectedIfTrue),
    disprovedIf: str(rawTest.disprovedIf),
  };
  if (!test.description || !test.expectedIfTrue || !test.disprovedIf || test.expectedIfTrue === test.disprovedIf) {
    missing.push("a test that could disprove it");
  }

  if (missing.length) return { ok: false, missing };
  const confidence = Number(reply.confidence);
  const scenario = rawTest.scenario;
  return {
    ok: true,
    hypothesis,
    evidence,
    change: { ...change, kind: kind!, scope },
    test: { ...test, ...(isScenario(scenario) && scenarios.includes(scenario) && { scenario }) },
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    connectedCaseIds: [...cases],
  };
}
