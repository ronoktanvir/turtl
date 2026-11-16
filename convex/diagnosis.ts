import type { Doc } from "./_generated/dataModel";
import type { Gate } from "./consent/gate";
import type { Facts } from "./runner/handlers/journey";
import { supportedFactKeys } from "./memory/checks";
import { CONFIGURATIONS, type ConfigKey, type Configuration, type ModelRef } from "./routing/configs";
import { callModel, type ModelAnswer } from "./routing/models";
import type { Traits } from "./routing/selector";

declare const process: { env: Record<string, string | undefined> };

// Diagnosis turns the facts and evidence into a cause in plain language, with the configuration the router chose.
// When no model answers, a deterministic reading of the facts is used and labelled as such: it is never presented as
// a model's diagnosis.

export const MODEL_ENV = "DIAGNOSIS_MODEL";
export const DEFAULT_MODEL = CONFIGURATIONS.quick.model.model;

// The quick configuration's model; DIAGNOSIS_MODEL overrides it, as before routing existed.
export const modelId = () => process.env[MODEL_ENV] || DEFAULT_MODEL;

export const modelFor = (config: Configuration): ModelRef =>
  config.key === "quick" ? { ...config.model, model: modelId() } : config.model;

export type EvidenceSummary = {
  id: string;
  kind: string;
  title: string;
  body?: string;
};

export type Reading = {
  cause: string;
  confidence: number;
  supportingEvidenceIds: string[];
  supportingFactKeys: string[];
  alternatives: string[];
  missingEvidence: string[];
};

export type LookAlike = { memoryId: string; failedChecks: string[] };

export type DiagnosisContext = {
  facts: Facts;
  evidence: EvidenceSummary[];
  pastCases: string[];
  lookAlikes: LookAlike[];
  handoff?: string;
};

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 8) : [];

// What each configuration receives: the same facts, with evidence detail, past cases, look-alike memories and the
// handoff as its context settings say.
export function payloadFor(config: Configuration, context: DiagnosisContext) {
  const limit = config.context.evidenceBodyChars;
  const evidence = context.evidence.map((item) => ({
    ...item,
    ...(item.body !== undefined && { body: limit === null ? item.body : item.body.slice(0, limit) }),
  }));
  const pastCases = context.pastCases.slice(0, config.context.pastCases);
  return {
    facts: context.facts,
    evidence,
    ...(pastCases.length && { pastCases }),
    ...(config.context.lookAlikeMemories && context.lookAlikes.length && { lookAlikeMemories: context.lookAlikes }),
    ...(config.context.handoff && context.handoff && { handoff: context.handoff }),
  };
}

export async function askModel(
  gate: Gate,
  config: Configuration,
  context: DiagnosisContext,
): Promise<{ answer: ModelAnswer; reading: Reading | null; unusable?: string }> {
  const answer = await callModel(gate, {
    ref: modelFor(config),
    system: config.instructions.join("\n"),
    user: JSON.stringify(payloadFor(config, context)),
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
  });
  if (!answer.ok) return { answer, reading: null };
  const parsed = answer.json;
  if (typeof parsed.cause !== "string" || !parsed.cause.trim()) {
    return { answer, reading: null, unusable: "the model's answer had no cause" };
  }
  const known = new Set(context.evidence.map((e) => e.id));
  const confidence = Number(parsed.confidence);
  return {
    answer,
    reading: {
      cause: parsed.cause.trim(),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      supportingEvidenceIds: strings(parsed.supportingEvidenceIds).filter((id) => known.has(id)),
      supportingFactKeys: supportedFactKeys(context.facts, parsed.supportingFactKeys as string[] | undefined),
      alternatives: strings(parsed.alternatives),
      missingEvidence: strings(parsed.missingEvidence),
    },
  };
}

const SENSITIVE = /\b(auth\w*|login|sign[- ]?in|session|token|password|permission\w*|payment\w*|billing|charge|refund|delete\w*|migration|secret\w*)\b/i;

// The case traits the selector reads. Difficulty and consequence are kept apart: a sensitive area or an irreversible
// action raises consequence however easy the failure looks.
export function traitsFor(args: {
  row: Doc<"cases">;
  facts: Facts;
  evidence: EvidenceSummary[];
  catalog: Doc<"actionCatalog">[];
  recall: { applies: boolean }[];
  verifiedFailures: string[];
}): Traits {
  const { row, facts, evidence, catalog, recall, verifiedFailures } = args;
  const verdict = facts["journey.verdict"];
  const step = typeof facts["journey.failedStep"] === "string" ? facts["journey.failedStep"] : "none";
  const code = typeof facts["journey.errorCode"] === "string" ? facts["journey.errorCode"] : "none";
  const topCode = facts["errors.topCode"];
  const signals: string[] = [];
  const components = new Set<string>();
  if (verdict === "failed") {
    signals.push(`the journey fails at ${step}`);
    components.add(step);
  }
  if (typeof facts["errors.failedBookings"] === "number" && facts["errors.failedBookings"] > 0) {
    signals.push(`${facts["errors.failedBookings"]} customer attempts failed`);
  }
  if (typeof topCode === "string" && topCode !== "none" && topCode !== code) {
    signals.push(`customers see ${topCode}, not ${code}`);
    components.add(topCode);
  }
  if (facts["health.ok"] === false) {
    signals.push("the server's health check fails");
    components.add("server");
  }
  const expected = ["journey_check", "errors", "flags", "health", "revision"];
  const kinds = new Set(evidence.map((item) => item.kind));
  const failure = `${step}:${code}`;
  const sensitive = SENSITIVE.exec([step, code, row.title].join(" "));
  const irreversible = catalog.filter((entry) => !entry.reversible);
  const reversible = catalog.filter((entry) => entry.reversible).map((entry) => entry.name);
  return {
    caseKind: row.kind,
    reproduces: verdict === "failed" ? "yes" : verdict === "passed" ? "no" : "unknown",
    signals,
    components: [...components],
    evidenceKinds: expected.filter((kind) => kinds.has(kind)).length,
    evidenceExpected: expected.length,
    memory: recall.some((item) => item.applies) ? "matched" : recall.length ? "look_alike_rejected" : "none",
    familiarFailure: verifiedFailures.includes(failure),
    failure,
    consequence: sensitive || irreversible.length ? "high" : "low",
    consequenceWhy: sensitive
      ? `the failure touches ${sensitive[0].toLowerCase()}`
      : irreversible.length
        ? `the app's actions include ${irreversible.map((entry) => entry.name).join(", ")}, which cannot be undone`
        : reversible.length
          ? `the actions on offer can be undone (${reversible.join(", ")})`
          : "no recovery action is registered, so only a reviewed code change could follow",
  };
}

// The deterministic fallback: fixed rules over the facts. Its confidence is capped low on purpose.
export function ruleReading(facts: Facts, evidence: EvidenceSummary[]): Reading {
  const byKind = (kinds: string[]) => evidence.filter((e) => kinds.includes(e.kind)).map((e) => e.id);
  const none = { alternatives: [], missingEvidence: [] };
  if (facts["journey.verdict"] === "passed") {
    return {
      cause: "The booking check passes now, so these facts show no current failure to explain.",
      confidence: 0.2,
      supportingEvidenceIds: byKind(["journey_check"]),
      supportingFactKeys: ["journey.verdict"],
      ...none,
    };
  }
  if (
    facts["journey.failedStep"] === "recommendations" &&
    facts["journey.errorCode"] === "RECOMMENDATIONS_TIMEOUT" &&
    facts["flags.recommendationsEnabled"] === true &&
    facts["health.ok"] === true
  ) {
    return {
      cause:
        "Booking waits for service recommendations while they are turned on, and the recommendations provider is timing out, so bookings never get saved.",
      confidence: 0.5,
      supportingEvidenceIds: byKind(["journey_check", "flags", "errors"]),
      supportingFactKeys: ["journey.verdict", "journey.failedStep", "journey.errorCode", "flags.recommendationsEnabled", "health.ok"],
      ...none,
    };
  }
  const step = facts["journey.failedStep"] ?? "unknown";
  const code = facts["journey.errorCode"] ?? "unknown";
  return {
    cause: `The booking check fails at the "${step}" step with ${code}. No rule matches this, so the cause is unknown.`,
    confidence: 0.1,
    supportingEvidenceIds: byKind(["journey_check"]),
    supportingFactKeys: supportedFactKeys(facts, ["journey.verdict", "journey.failedStep", "journey.errorCode"]),
    ...none,
  };
}

export const configuration = (key: ConfigKey) => CONFIGURATIONS[key];
