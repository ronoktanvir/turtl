import type { ConfigKey, Configuration } from "./configs";

// Chooses the investigate configuration for one case. A pure function of the case's traits, its limits and the
// performance log, so the same inputs always give the same choice. This is routing that updates from recorded
// outcomes, not models that learn.

export type Outcome = "verified" | "corrected" | "failed" | "infra_failure";

export type Traits = {
  caseKind: string;
  reproduces: "yes" | "no" | "unknown";
  signals: string[];
  components: string[];
  evidenceKinds: number;
  evidenceExpected: number;
  memory: "none" | "look_alike_rejected" | "matched";
  failure: string;
  familiarFailure: boolean;
  consequence: "low" | "high";
  consequenceWhy: string;
};

export type Limits = { timeLeftMs: number; budgetLeftUsd: number };

export type LogEntry = { configKey: string; bucket: string; outcome: Outcome };

export type Selection = {
  configKey: ConfigKey;
  reason: string;
  bucket: string;
  difficulty: number;
  difficultyFactors: string[];
  record: Record<ConfigKey, { counted: number; verified: number }>;
};

export const CAREFUL_AT_DIFFICULTY = 2;
export const MIN_SAMPLE = 3;
export const PREFER_CAREFUL_BELOW = 0.5;
export const PREFER_QUICK_AT = 0.8;
export const ESCALATE_BELOW = 0.6;

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// Similar task traits: raw success rates across easy and hard work are not comparable, so the log is read only within
// the same bucket.
export function bucketOf(traits: Traits): string {
  const breadth = traits.signals.length > 2 || traits.components.length > 1 ? "several signals" : "one signal";
  const familiarity = traits.memory === "look_alike_rejected" ? "look-alike" : traits.familiarFailure ? "familiar" : "unfamiliar";
  const area = traits.components.length ? [...traits.components].sort().join("+") : "none";
  return [traits.caseKind, `area:${area}`, `reproduces:${traits.reproduces}`, breadth, familiarity, `consequence:${traits.consequence}`].join("|");
}

export function difficultyOf(traits: Traits): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;
  if (traits.reproduces === "no") {
    score += 2;
    factors.push("the failure did not reproduce on a fresh check");
  } else if (traits.reproduces === "unknown") {
    score += 1;
    factors.push("a fresh check could not be run");
  }
  if (traits.components.length > 1) {
    score += 1;
    factors.push(`${plural(traits.components.length, "component")} are involved (${traits.components.join(", ")})`);
  }
  if (traits.signals.length > 2) {
    score += 1;
    factors.push(`${plural(traits.signals.length, "signal")} are abnormal`);
  }
  if (traits.evidenceKinds < traits.evidenceExpected) {
    score += 1;
    factors.push(`only ${traits.evidenceKinds} of ${traits.evidenceExpected} kinds of evidence could be read`);
  }
  if (traits.memory === "look_alike_rejected") {
    score += 1;
    factors.push("an earlier recovery for a similar symptom was checked and does not fit");
  }
  if (!traits.familiarFailure) {
    score += 1;
    factors.push("this failure has not been seen in a verified case before");
  }
  return { score, factors };
}

function tally(log: LogEntry[], bucket: string, configKey: ConfigKey) {
  let counted = 0;
  let verified = 0;
  for (const entry of log) {
    if (entry.bucket !== bucket || entry.configKey !== configKey || entry.outcome === "infra_failure") continue;
    counted += 1;
    if (entry.outcome === "verified") verified += 1;
  }
  return { counted, verified };
}

export function selectConfiguration(args: {
  traits: Traits;
  limits: Limits;
  log: LogEntry[];
  configs: Record<ConfigKey, Pick<Configuration, "label" | "estimatedCostUsd" | "timeoutMs">>;
}): Selection {
  const { traits, limits, log, configs } = args;
  const bucket = bucketOf(traits);
  const { score, factors } = difficultyOf(traits);
  const record = { quick: tally(log, bucket, "quick"), careful: tally(log, bucket, "careful") };
  const quick = configs.quick.label;
  const careful = configs.careful.label;
  const done = (configKey: ConfigKey, reason: string): Selection => ({
    configKey, reason, bucket, difficulty: score, difficultyFactors: factors, record,
  });

  let choice: ConfigKey;
  let reason: string;
  const policyFloor = traits.consequence === "high";
  if (policyFloor) {
    choice = "careful";
    reason = `${careful}: the action this could lead to is consequential (${traits.consequenceWhy}), so it gets the careful configuration however easy it looks.`;
  } else if (score >= CAREFUL_AT_DIFFICULTY) {
    choice = "careful";
    reason = `${careful}: ${factors.join("; ")}.`;
  } else {
    choice = "quick";
    reason = factors.length
      ? `${quick}: the failure reproduces and points at one place; ${factors.join("; ")}, which alone is not enough to need a careful review.`
      : `${quick}: the failure reproduces, points at one place, and has been seen before.`;
  }

  const q = record.quick;
  if (choice === "quick" && q.counted >= MIN_SAMPLE && q.verified / q.counted < PREFER_CAREFUL_BELOW) {
    choice = "careful";
    reason = `${careful}: the performance log changed this. In ${plural(q.counted, "similar case")} the ${quick.toLowerCase()} was verified in ${q.verified}, below half, so this goes straight to the careful configuration.`;
  } else if (choice === "careful" && !policyFloor && q.counted >= MIN_SAMPLE && q.verified / q.counted >= PREFER_QUICK_AT) {
    choice = "quick";
    reason = `${quick}: the performance log changed this. The case looked harder (${factors.join("; ")}), but in ${plural(q.counted, "similar case")} the ${quick.toLowerCase()} was verified in ${q.verified}.`;
  }

  if (choice === "careful") {
    const short: string[] = [];
    if (limits.budgetLeftUsd < configs.careful.estimatedCostUsd) short.push(`the case has $${limits.budgetLeftUsd.toFixed(2)} of model budget left`);
    if (limits.timeLeftMs < configs.careful.timeoutMs) short.push(`the step has ${Math.round(limits.timeLeftMs / 1000)} s left`);
    if (short.length) {
      return done("quick", `${quick}, though ${reason.charAt(0).toLowerCase()}${reason.slice(1).replace(/\.$/, "")}. The careful configuration does not fit the limits: ${short.join(" and ")}.`);
    }
  }
  return done(choice, reason);
}

export type ReadingCheck = {
  confidence: number;
  supportingEvidenceIds: string[];
  supportingFactKeys: string[];
};

// Symptoms say what failed; context says where. Neither says why on its own.
const symptomOrContext = (key: string, facts: Record<string, unknown>) =>
  key.startsWith("journey.") || key.startsWith("errors.") || key === "app.revision" || (key === "health.ok" && facts[key] === true);

// Whether a diagnosis establishes a cause: enough confidence, support that accounts for the observed failure, and at
// least one observation beyond the failure's own symptoms. Returns the reasons it does not, in plain words; an empty
// list means it does.
export function unsupportedReasons(
  reading: ReadingCheck,
  facts: Record<string, unknown>,
  evidenceKinds: Record<string, string>,
): string[] {
  const reasons: string[] = [];
  if (reading.confidence < ESCALATE_BELOW) {
    reasons.push(`its confidence is ${Math.round(reading.confidence * 100)}%, below ${Math.round(ESCALATE_BELOW * 100)}%`);
  }
  if (!reading.supportingEvidenceIds.length) reasons.push("it cites no evidence");
  const failed = facts["journey.verdict"] === "failed";
  const accounts = ["journey.failedStep", "journey.errorCode"].some((key) => reading.supportingFactKeys.includes(key));
  if (failed && !accounts) reasons.push("it does not account for the failed step or its error code");
  const corroborated =
    reading.supportingFactKeys.some((key) => !symptomOrContext(key, facts)) ||
    reading.supportingEvidenceIds.some((id) => !["journey_check", "errors", "revision", "health"].includes(evidenceKinds[id] ?? "journey_check"));
  if (failed && !corroborated) {
    reasons.push("it rests only on the failure's own symptoms, which show what failed but not why");
  }
  return reasons;
}
