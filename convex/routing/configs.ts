// The investigate configurations, the model client's provider table, and list prices: the one place they are defined.
// This file imports nothing, so the selector's tests can load it directly.

export type Provider = "openai" | "anthropic" | "google";
export type Reasoning = "low" | "medium" | "high";
export type ModelRef = { provider: Provider; model: string; reasoning?: Reasoning };

// A provider's models can be called only when its key is set on the deployment.
export const PROVIDER_KEYS: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

// Standard list prices in US dollars per million tokens, as published in November 2026. Costs shown to the owner are
// estimates from the token counts each provider reports; a model missing here has no cost estimate.
export const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-6.1-terra": { input: 1, output: 5 },
  "gpt-6.1-sol": { input: 2, output: 10 },
  "gpt-6-astra": { input: 10, output: 50 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = PRICES_PER_MILLION[model];
  if (!price) return undefined;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export type ConfigKey = "quick" | "careful";

export type Configuration = {
  key: ConfigKey;
  label: string;
  summary: string;
  model: ModelRef;
  harnessVersion: string;
  promptVersion: string;
  instructions: string[];
  context: {
    evidenceBodyChars: number | null;
    pastCases: number;
    lookAlikeMemories: boolean;
    handoff: boolean;
  };
  timeoutMs: number;
  maxOutputTokens: number;
  estimatedCostUsd: number;
  escalatesTo?: ConfigKey;
};

const SHARED_INSTRUCTIONS = [
  "You diagnose an outage in a small app for its owner, who is not an engineer.",
  "Use only the facts and evidence you are given. Do not invent causes they do not support.",
  "cause: at most two plain sentences saying why customers cannot complete the journey.",
  "confidence: from 0 to 1, how strongly the evidence supports that cause.",
  "supportingEvidenceIds: ids from the evidence list that support it.",
  "supportingFactKeys: exact keys from the supplied facts whose observed values support this cause. Name the failed journey step and error code when relevant; do not name facts you did not use. Never infer or include staging switches.",
  "If the evidence does not establish a cause, say so and give a low confidence.",
  "pastCases, when present: notes from earlier cases on this app, background only. They may not apply; the fresh facts and evidence decide. Never cite a past case as support, and a past recovery is not a recommendation or an approval.",
];

export const CONFIGURATIONS: Record<ConfigKey, Configuration> = {
  quick: {
    key: "quick",
    label: "Quick look",
    summary: "A small, fast model with light reasoning, for a failure that reproduces and points at one place.",
    model: { provider: "openai", model: "gpt-5.4-mini", reasoning: "low" },
    harnessVersion: "turtl-diagnosis-v2",
    promptVersion: "diagnosis-quick-v2",
    instructions: [
      ...SHARED_INSTRUCTIONS,
      "This is a quick look. Name a cause only when the observations show both what failed and why the journey breaks because of it, at the level the owner can act on: at least one observation beyond the failing check and the error counts (such as a flag or setting, a health reading, or a revision change) must explain why this failure stops the journey, and its fact key must be in supportingFactKeys. You need not explain why an outside provider is slow or down. When only the failure's own symptoms are there, say what is missing and keep confidence below 0.5, so a more careful review takes over.",
      'Reply with a JSON object: {"cause": string, "confidence": number, "supportingEvidenceIds": string[], "supportingFactKeys": string[], "missingEvidence": string[]}.',
    ],
    context: { evidenceBodyChars: 300, pastCases: 3, lookAlikeMemories: false, handoff: false },
    timeoutMs: 30_000,
    maxOutputTokens: 2_000,
    estimatedCostUsd: 0.01,
    escalatesTo: "careful",
  },
  careful: {
    key: "careful",
    label: "Careful review",
    summary: "A stronger model with high reasoning and the full evidence, for unclear, repeated-but-different, or sensitive cases.",
    model: { provider: "openai", model: "gpt-6.1-sol", reasoning: "high" },
    harnessVersion: "turtl-diagnosis-v2",
    promptVersion: "diagnosis-careful-v2",
    instructions: [
      ...SHARED_INSTRUCTIONS,
      "This is a careful review. Before answering, consider at least two explanations that fit the observations and say which observation tells them apart.",
      "lookAlikeMemories, when present: earlier recoveries for a similar symptom whose conditions did not hold now. They show what this case is not; never treat them as support.",
      "handoff, when present: a quicker review that could not establish a cause handed its reading up to you. Check it against the evidence; do not adopt it without support.",
      "missingEvidence: the observations that would confirm or rule out the cause, in plain words.",
      "A cause is established only when an observation beyond the failing check and the error counts (such as a flag or setting, a health reading, or a revision change) explains why this failure stops the journey; put that observation's fact key in supportingFactKeys. You need not explain why an outside provider is slow or down. Restating the error code is not a cause.",
      'Reply with a JSON object: {"cause": string, "confidence": number, "supportingEvidenceIds": string[], "supportingFactKeys": string[], "alternatives": string[], "missingEvidence": string[]}.',
    ],
    context: { evidenceBodyChars: null, pastCases: 3, lookAlikeMemories: true, handoff: true },
    timeoutMs: 90_000,
    maxOutputTokens: 12_000,
    estimatedCostUsd: 0.12,
  },
};

export const ROUTING_POLICY_VERSION = "routing-v1";

// The most one case may spend on diagnosis models, the council excluded.
export const DIAGNOSIS_BUDGET_USD = 0.5;
