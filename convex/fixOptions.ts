import type { Doc, Id } from "./_generated/dataModel";
import type { Criterion, Delivery, OptionKind, ProposalOption, Span } from "./constants";
import { checkParameters } from "./decisions";
import { modelId as diagnosisModelId } from "./diagnosis";
import type { Facts } from "./runner/handlers/journey";

declare const process: { env: Record<string, string | undefined> };

// The fixes an owner chooses from. Every option is bound to an entry in the app's action catalog, so what
// the owner approves is what decisions.ts freezes and runs: the catalog action itself, or a code change
// that ships as a pull request through the catalog's capy entry. The model writes the words and the change
// request; it never writes a target, a catalog id or an action parameter outside the entry's constraints.

export const MAX_FIXES = 4;
export const FIXES_MODEL_ENV = "FIXES_MODEL";
const MODEL_TIMEOUT_MS = 30_000;
const CODE_CHANGE_KINDS: OptionKind[] = ["recovery", "repair", "prevention"];

export const fixesModelId = () => process.env[FIXES_MODEL_ENV] || diagnosisModelId();

// The contract's FixOption (ui-contract.md section 6), plus how an approval reaches the app.
export type FixOption = {
  key: string;
  title: string;
  kind: OptionKind;
  recommended: boolean;
  why: Span[];
  whatChanges: string;
  whatMightBeLost: string;
  howChecked: string;
  usersCantNow?: string;
  confidence?: number;
  codeIds?: string[];
  proposedInChat?: boolean;
  delivery: Delivery;
};

export function toFixOption(option: ProposalOption): FixOption {
  return {
    key: option.key,
    title: option.title,
    kind: option.kind,
    recommended: option.recommended,
    why: option.why ?? [{ text: option.whatChanges }],
    whatChanges: option.whatChanges,
    whatMightBeLost: option.whatMightBeLost,
    howChecked: option.howChecked,
    ...(option.usersCantNow && { usersCantNow: option.usersCantNow }),
    confidence: option.confidence,
    ...(option.codeIds && { codeIds: option.codeIds }),
    ...(option.proposedInChat && { proposedInChat: true }),
    delivery: option.delivery ?? "action",
  };
}

// Recommended first, the rest in the order they were proposed.
export const orderFixes = (options: ProposalOption[]) =>
  [...options].sort((a, b) => Number(b.recommended) - Number(a.recommended));

export const pullRequestEntry = (catalog: Doc<"actionCatalog">[]) =>
  catalog.find((entry) => entry.config.kind === "capy") ?? null;

export type CodeChangeDraft = {
  title: string;
  kind: OptionKind;
  why: string;
  whatChanges: string;
  whatMightBeLost: string;
  howChecked: string;
  change: string;
  confidence: number;
};

export type PlanBasis = {
  journey: Doc<"journeys">;
  doneMeans: Criterion[];
  evidenceIds: Id<"evidence">[];
  usersCantNow?: string;
};

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const keyFor = (title: string, taken: string[]) => {
  const stem =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "fix";
  let key = stem;
  for (let n = 2; taken.includes(key); n++) key = `${stem}_${n}`;
  return key;
};

// A code change bound to the catalog's pull request entry. Throws when the parameters break its constraints.
export function pullRequestOption(
  entry: Doc<"actionCatalog">,
  draft: CodeChangeDraft,
  basis: PlanBasis,
  key: string,
): ProposalOption {
  if (entry.config.kind !== "capy") throw new Error("The catalog entry does not open pull requests.");
  const parameters = [
    { name: "title", value: draft.title },
    { name: "change", value: draft.change },
  ];
  checkParameters(parameters, entry.parameterConstraints);
  const repo = entry.config.repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return {
    key,
    title: draft.title,
    kind: draft.kind,
    actionType: entry.type,
    actionCatalogId: entry._id,
    target: { environment: "github", resourceRef: `${repo}@${entry.config.baseBranch}` },
    parameters,
    acceptanceCriteria: basis.doneMeans,
    checkRefs: [{ journeyId: basis.journey._id, version: basis.journey.checkVersion }],
    ...(basis.usersCantNow && { usersCantNow: basis.usersCantNow }),
    whatChanges: `${draft.whatChanges} This is a code change: turtl opens a pull request, and nothing changes for customers until you merge it.`,
    whatMightBeLost: draft.whatMightBeLost,
    howChecked: `${draft.howChecked} After you merge, turtl runs the "${basis.journey.name}" check again.`,
    evidenceIds: basis.evidenceIds,
    recommended: false,
    confidence: clamp(draft.confidence),
    why: [{ text: draft.why }],
    delivery: "pull_request",
  };
}

// Reads a model's code change; null when a field is missing or the kind is not one turtl offers for an outage.
export function readDraft(raw: unknown): CodeChangeDraft | null {
  const fix = (raw ?? {}) as Record<string, unknown>;
  const kind = fix.kind as OptionKind;
  const draft = {
    title: text(fix.title).slice(0, 80),
    kind,
    why: text(fix.why),
    whatChanges: text(fix.whatChanges),
    whatMightBeLost: text(fix.whatMightBeLost),
    howChecked: text(fix.howChecked),
    change: text(fix.change),
    confidence: clamp(Number(fix.confidence)),
  };
  if (!CODE_CHANGE_KINDS.includes(kind)) return null;
  if (!draft.title || !draft.why || !draft.whatChanges || !draft.whatMightBeLost || !draft.howChecked || !draft.change) {
    return null;
  }
  return draft;
}

export const FIX_FIELDS =
  'A code change is written {"title": string (at most 8 words), "kind": "recovery" | "repair" | "prevention", "why": string, "whatChanges": string, "whatMightBeLost": string, "howChecked": string, "change": string, "confidence": number}. why: one or two plain sentences on why it would work, citing what the evidence shows. whatChanges: what changes for customers and in the app. whatMightBeLost: the honest trade-offs. howChecked: how turtl would check it worked. change: precise instructions for the engineer writing the pull request (what behaviour to change, and where if the evidence shows it). confidence: 0 to 1.';

// One JSON-mode chat completion. Never throws; a missing key or a failed call is a reason.
export async function askJson(
  system: string,
  user: unknown,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: "OPENAI_API_KEY is not set on this deployment, so no model was asked" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: fixesModelId(),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `the model call returned HTTP ${response.status}` };
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const json = JSON.parse(body.choices?.[0]?.message?.content ?? "null") as unknown;
    if (!json || typeof json !== "object") return { ok: false, reason: "the model's answer was not a JSON object" };
    return { ok: true, json: json as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `the model did not answer within ${MODEL_TIMEOUT_MS / 1000} s`
        : `the model call failed (${error instanceof Error ? error.name : "unknown error"})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const PLAN_PROMPT = [
  "You propose fixes for an outage in a small app, for its owner, who is not an engineer.",
  "Use only the facts, evidence and diagnosis you are given. Do not invent causes or code they do not support.",
  'Reply with a JSON object: {"fixes": Fix[]}, one to four fixes that differ in kind where the evidence supports it: recovery (restore service now), repair (fix the cause properly), prevention (stop it happening again).',
  'The app\'s catalog action is written {"uses": "<its key>", "why": string, "recommended": boolean}; include it when it helps.',
  `Every other fix must be a code change that ships as a pull request. ${FIX_FIELDS} Add "recommended": boolean.`,
  "Mark exactly one fix recommended: the one the owner should approve first. While customers are affected, restoring service usually comes first.",
  "Offer nothing that is neither the catalog action nor a code change.",
].join("\n");

export type PlanInput = {
  base: ProposalOption;
  baseRecommended: boolean;
  remembered: boolean;
  catalog: Doc<"actionCatalog">[];
  basis: PlanBasis;
  appName: string;
  caseRow: Doc<"cases">;
  facts: Facts;
  cause: string | null;
  evidence: Doc<"evidence">[];
};

// Proposal options for the plan step: the catalog option always, plus up to three code changes from the
// model, with exactly one recommended when anything supports a recommendation. With no model answer the
// catalog option is offered alone, as before.
export async function planFixes(input: PlanInput): Promise<{ options: ProposalOption[]; note: string }> {
  const { base, basis } = input;
  const baseWhy: Span[] = [
    {
      text: input.remembered
        ? "This exact recovery restored service before, and its conditions were checked again against this case."
        : `${input.cause ?? "The cause is not established."} Turning off recommendations removes that wait, so customers can finish booking again.`,
    },
  ];
  const fallback = (reason: string) => ({
    options: [{ ...base, why: baseWhy, delivery: "action" as const }],
    note: `Only the catalog action is offered: ${reason}.`,
  });

  const entry = pullRequestEntry(input.catalog);
  const answer = await askJson(
    entry ? PLAN_PROMPT : `${PLAN_PROMPT}\nThis app cannot ship code changes yet: offer only the catalog action.`,
    {
      app: input.appName,
      case: { title: input.caseRow.title, impact: input.caseRow.impact },
      facts: input.facts,
      diagnosis: input.cause,
      evidence: input.evidence.map((e) => ({ id: e._id, kind: e.kind, title: e.title, body: e.body?.slice(0, 600) })),
      catalogAction: {
        key: base.key,
        title: base.title,
        whatChanges: base.whatChanges,
        whatMightBeLost: base.whatMightBeLost,
        factsSupportIt: input.baseRecommended,
      },
      rememberedRecovery: input.remembered,
    },
  );
  if (!answer.ok) return fallback(answer.reason);
  const fixes = Array.isArray(answer.json.fixes) ? (answer.json.fixes as Record<string, unknown>[]) : [];

  const usesBase = fixes.find((f) => f?.uses === base.key);
  const options: ProposalOption[] = [
    {
      ...base,
      why: text(usesBase?.why) ? [{ text: text(usesBase?.why) }] : baseWhy,
      delivery: "action",
    },
  ];
  const flagged: string[] = usesBase?.recommended === true ? [base.key] : [];
  let dropped = 0;
  for (const raw of fixes) {
    if (!raw || raw.uses !== undefined) continue;
    const draft = readDraft(raw);
    if (!draft || !entry || options.length >= MAX_FIXES) {
      dropped++;
      continue;
    }
    const key = keyFor(draft.title, options.map((o) => o.key));
    try {
      options.push(pullRequestOption(entry, draft, basis, key));
      if (raw.recommended === true) flagged.push(key);
    } catch {
      dropped++;
    }
  }

  // The catalog action keeps its rule-based recommendation (memory and permissions depend on it); otherwise
  // the model's pick among the code changes stands, then the most confident one.
  const drafts = options.slice(1);
  const pick =
    input.remembered || input.baseRecommended
      ? base.key
      : (flagged.find((key) => key !== base.key) ??
        drafts.reduce<ProposalOption | null>((best, o) => (!best || o.confidence > best.confidence ? o : best), null)
          ?.key ??
        null);
  for (const option of options) option.recommended = option.key === pick;

  const notes = [
    `${options.length} fix${options.length === 1 ? "" : "es"} offered (${fixesModelId()}).`,
    dropped ? `${dropped} suggestion(s) were not offered: ${entry ? "incomplete, over the limit of four, or outside the catalog's constraints" : "this app has no pull request action in its catalog, so code changes cannot be approved yet"}.` : "",
    pick ? "" : "No fix is recommended: the facts don't point to the catalog action and no code change was offered.",
  ];
  return { options: orderFixes(options), note: notes.filter(Boolean).join(" ") };
}
