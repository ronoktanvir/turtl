import type { Doc, Id } from "./_generated/dataModel";
import type { Gate } from "./consent/gate";
import type { Criterion, Delivery, OptionKind, ProposalOption, Span } from "./constants";
import { checkParameters } from "./decisions";
import { modelId as diagnosisModelId } from "./diagnosis";
import { fingerprint, pastDecisionLine, recommend, type TurnedDown } from "./learning/rules";
import { codeChangeInstructions, instructionsToSend } from "./prTracking/capy";
import type { Facts } from "./runner/handlers/journey";
import { modelCost } from "./spend/limits";

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
  preferences?: { id: string; statement: string }[];
  pastDecisions?: string;
  sends?: FixSends;
};

// What approving sends, word for word as the option stores it (TUR-68): the coding agent's full instructions for a
// code change, or the catalog action with the exact target and values decisions.ts freezes and runs.
export type FixSends =
  | { kind: "instructions"; text: string }
  | { kind: "action"; name: string; description?: string; target: string; values: { name: string; value: string }[] };

type CatalogWords = Pick<Doc<"actionCatalog">, "name" | "description">;

export function sendsOf(option: ProposalOption, entry?: CatalogWords | null): FixSends | undefined {
  if (option.delivery === "pull_request") {
    const text = instructionsToSend(option.parameters, option.target);
    return text ? { kind: "instructions", text } : undefined;
  }
  return {
    kind: "action",
    name: entry?.name ?? option.title,
    ...(entry?.description && { description: entry.description }),
    target: `${option.target.resourceRef} (${option.target.environment.replace(/[_-]+/g, " ")})`,
    values: option.parameters.map((p) => ({ name: p.name, value: JSON.stringify(p.value) })),
  };
}

export function toFixOption(option: ProposalOption, entry?: CatalogWords | null): FixOption {
  const sends = sendsOf(option, entry);
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
    ...(option.preferences?.length && {
      preferences: option.preferences.map((p) => ({ id: p.preferenceId as string, statement: p.statement })),
    }),
    ...(option.pastDecisions && { pastDecisions: option.pastDecisions }),
    ...(sends && { sends }),
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
  const repo = entry.config.repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  // The stored "change" is the coding agent's full instructions, so the owner approves the exact text that is sent.
  const change = codeChangeInstructions({ repo, baseBranch: entry.config.baseBranch, title: draft.title, change: draft.change });
  const parameters = [
    { name: "title", value: draft.title },
    { name: "change", value: change },
  ];
  checkParameters(parameters, entry.parameterConstraints);
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
export function readDraft(raw: unknown, kinds: OptionKind[] = CODE_CHANGE_KINDS): CodeChangeDraft | null {
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
  if (!kinds.includes(kind)) return null;
  if (!draft.title || !draft.why || !draft.whatChanges || !draft.whatMightBeLost || !draft.howChecked || !draft.change) {
    return null;
  }
  return draft;
}

export const FIX_FIELDS =
  'A code change is written {"title": string (at most 8 words), "kind": "recovery" | "repair" | "prevention", "why": string, "whatChanges": string, "whatMightBeLost": string, "howChecked": string, "change": string, "confidence": number}. why: one or two plain sentences on why it would work, citing what the evidence shows. whatChanges: what changes for customers and in the app. whatMightBeLost: the honest trade-offs. howChecked: how turtl would check it worked. change: precise instructions for the engineer writing the pull request (what behaviour to change, and where if the evidence shows it). confidence: 0 to 1.';

// One JSON-mode chat completion. Never throws; a missing key, the gate's no, or a failed call is a reason.
export async function askJson(
  gate: Gate,
  system: string,
  user: unknown,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: "OPENAI_API_KEY is not set on this deployment, so no model was asked" };
  const opened = await gate.open("openai");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const model = fixesModelId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await opened.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `the model call returned HTTP ${response.status}` };
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    await gate.spent(modelCost(model, body.usage && { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 }));
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
  "Each fix must differ in substance from the others: two fixes that change the same thing in the same way are one fix, and fewer distinct fixes are better than overlapping ones.",
  "Mark exactly one fix recommended: the one the owner should approve first. While customers are affected, restoring service usually comes first.",
  "Offer nothing that is neither the catalog action nor a code change.",
  "pastDecisions are how the owner decided earlier cases on this app: what turtl recommended, what the owner did and their note. Weigh them. If you recommend something the owner turned down under the same conditions, say why in plain words in its why.",
  'context is code, documents, past cases and recovery memories turtl gathered; possiblyStale ones were recorded at another app revision and need fresh evidence before you rely on them. On every fix, add "contextRefs": the refs of the context entries it relies on, or [].',
].join("\n");

const PREFERENCE_PROMPT = [
  "ownerPreferences are what the owner told turtl matters for this app. They are not evidence: never use one to claim a cause or that a fix works.",
  "Weigh them when you choose the recommended fix. When a preference rules a fix out and another offered fix addresses the failure while honouring it, recommend the fix that honours it, even if it is slower, and start its why with \"You asked to ..., so ...\". If you still recommend a fix that goes against a preference, say plainly in its why why it is still the right first step.",
  'On every fix, add "preferences": an object from preference ref to "honours" or "against", for each preference the fix keeps or breaks. Turning off a feature the owner asked to keep is "against"; changing code so that feature keeps working is "honours". Leave out preferences the fix does not bear on, and use {} when none apply.',
].join("\n");
const NO_PREFERENCES_PROMPT =
  "The owner has stated no preferences for this app. Never write that the owner asked for, wants or prefers anything.";

// A sentence claiming the owner asked for something, kept only on a fix that cites a stored preference.
const OWNER_CLAIM = /[^.]*\byou (asked|want|wanted|prefer)[^.]*\.\s*/gi;

export type PlanPreference = { id: Id<"ownerPreferences">; statement: string };
export type PlanContext = {
  id: Id<"contextUses">;
  kind: string;
  label: string;
  detail: string;
  helpedBefore: boolean;
  stale: boolean;
};
export type PlanFeedback = { turnedDown: TurnedDown; conditionsText: string; recent: unknown[] };

export type PlanInput = {
  base: ProposalOption;
  baseRecommended: boolean;
  remembered: boolean;
  /** Why the catalog option would work, after the cause, when no model wrote it. Default: the recommendations switch's. */
  baseReason?: string;
  catalog: Doc<"actionCatalog">[];
  basis: PlanBasis;
  appName: string;
  caseRow: Doc<"cases">;
  facts: Facts;
  cause: string | null;
  evidence: Doc<"evidence">[];
  preferences: PlanPreference[];
  feedback: PlanFeedback;
  context: PlanContext[];
};

const judged = (raw: unknown, verdict: "honours" | "against") => {
  const map = (raw as Record<string, unknown> | null)?.preferences;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).flatMap(([ref, value]) => (value === verdict ? [ref] : []));
};

const refsOf = (raw: unknown, field: string) =>
  Array.isArray((raw as Record<string, unknown> | null)?.[field])
    ? ((raw as Record<string, unknown>)[field] as unknown[]).filter((r): r is string => typeof r === "string")
    : [];

// Proposal options for the plan step: the catalog option always, plus up to three code changes from the
// model, with exactly one recommended when anything supports a recommendation. With no model answer the
// catalog option is offered alone, as before. The owner's preferences and past decisions shape which fix
// is recommended (learning/rules.ts); they never make a fix recommended that the facts don't support.
export async function planFixes(
  input: PlanInput,
  gate: Gate,
): Promise<{ options: ProposalOption[]; note: string; modelAnswered: boolean; noModelReason?: string }> {
  const { base, basis, preferences, feedback, context } = input;
  const baseWhy: Span[] = [
    {
      text: input.remembered
        ? "This exact recovery restored service before, and its conditions were checked again against this case."
        : `${input.cause ?? "The cause is not established."} ${input.baseReason ?? "Turning off recommendations removes that wait, so customers can finish booking again."}`,
    },
  ];
  const prefRef = (i: number) => `P${i + 1}`;
  const ctxRef = (i: number) => `C${i + 1}`;
  const baseSupported = input.remembered || input.baseRecommended;

  // Recommends one option, cites the preferences that shaped it, and says how the owner decided before.
  const settle = (
    options: ProposalOption[],
    flagged: string[],
    cited: Map<string, { preferenceRefs: string[]; againstPreferenceRefs: string[]; contextRefs: string[] }>,
    rulePick: string | null,
  ) => {
    const prefsFor = (key: string, field: "preferenceRefs" | "againstPreferenceRefs" = "preferenceRefs") =>
      (cited.get(key)?.[field] ?? []).flatMap((ref) => {
        const at = preferences.findIndex((_, i) => prefRef(i) === ref);
        return at === -1 ? [] : [preferences[at]];
      });
    const choice = recommend({
      candidates: options.map((o) => ({
        key: o.key,
        fingerprint: fingerprint(o),
        supported: o.key === base.key ? baseSupported : true,
        confidence: o.confidence,
        modelFlagged: flagged.includes(o.key),
        preferenceIds: prefsFor(o.key).map((p) => p.id),
        againstPreferenceIds: prefsFor(o.key, "againstPreferenceRefs").map((p) => p.id),
      })),
      rulePick,
      turnedDown: feedback.turnedDown,
    });
    for (const option of options) {
      option.recommended = option.key === choice.key;
      const shaped = prefsFor(option.key);
      const against = prefsFor(option.key, "againstPreferenceRefs").filter((p) => !shaped.includes(p));
      if (against.length && !(option.why ?? []).some((span) => /goes against what you asked/i.test(span.text))) {
        option.why = [...(option.why ?? []), { text: ` This goes against what you asked: "${against[0].statement}"` }];
      }
      if (!shaped.length && !against.length && option.why) {
        option.why = option.why
          .map((span) => ({ ...span, text: span.text.replace(OWNER_CLAIM, "") }))
          .filter((span) => span.text.trim());
      }
      if (shaped.length) {
        option.preferences = shaped.map((p) => ({ preferenceId: p.id, statement: p.statement }));
        const why = option.why ?? [];
        const replaced = choice.reason === "preference" ? options.find((o) => o.key === choice.replacedKey) : undefined;
        if (option.recommended && replaced) {
          option.why = [
            { text: `You asked: "${shaped[0].statement}" So turtl recommends this instead of "${replaced.title}", which goes against it. \"${replaced.title}\" is still offered if you would rather restore service that way. ` },
            ...why.map((span) => ({ ...span, text: span.text.replace(OWNER_CLAIM, "") })).filter((span) => span.text.trim()),
          ];
        } else if (option.recommended && !why.some((span) => /you asked/i.test(span.text))) {
          option.why = [{ text: `You asked: "${shaped[0].statement}" ` }, ...why];
        }
      }
      const used = (cited.get(option.key)?.contextRefs ?? []).flatMap((ref) => {
        const at = context.findIndex((_, i) => ctxRef(i) === ref);
        return at === -1 ? [] : [context[at].id];
      });
      if (used.length) option.contextIds = used;
      const history = feedback.turnedDown[fingerprint(option)];
      const role =
        choice.reason === "feedback" && option.key === choice.replacedKey
          ? "demoted"
          : choice.reason === "kept_despite_feedback" && option.recommended
            ? "kept"
            : "other";
      const line = pastDecisionLine(history, feedback.conditionsText, role);
      if (line) option.pastDecisions = line;
      if (choice.reason === "feedback" && option.recommended) {
        const replaced = options.find((o) => o.key === choice.replacedKey);
        option.pastDecisions = `Recommended instead of "${replaced?.title}", which you turned down ${(feedback.turnedDown[fingerprint(replaced!)]?.count ?? 2) === 2 ? "twice" : `${feedback.turnedDown[fingerprint(replaced!)]?.count} times`} when ${feedback.conditionsText}.`;
      }
    }
    const shapedBy = options.find((o) => o.recommended)?.preferences?.length ?? 0;
    const notes = [
      choice.reason === "preference" ? "Your preferences changed which fix is recommended." : "",
      shapedBy && choice.reason !== "preference" ? "The recommended fix cites your preferences." : "",
      choice.reason === "feedback"
        ? `Not recommending "${options.find((o) => o.key === choice.replacedKey)?.title}": you turned it down twice under the same conditions.`
        : "",
      choice.reason === "kept_despite_feedback"
        ? "The recommended fix was turned down twice before under the same conditions; it is still recommended because no other fix fits, and the owner is told why."
        : "",
    ];
    return { choice, notes: notes.filter(Boolean) };
  };

  const fallback = (reason: string) => {
    const options = [{ ...base, why: baseWhy, delivery: "action" as const }];
    const { notes } = settle(options, [], new Map(), baseSupported ? base.key : null);
    return {
      options,
      note: [
        `Only the catalog action is offered: ${reason}.`,
        preferences.length ? "Your preferences were not weighed because no model answered." : "",
        ...notes,
      ]
        .filter(Boolean)
        .join(" "),
      modelAnswered: false,
      noModelReason: reason,
    };
  };

  const entry = pullRequestEntry(input.catalog);
  const answer = await askJson(
    gate,
    [
      PLAN_PROMPT,
      preferences.length ? PREFERENCE_PROMPT : NO_PREFERENCES_PROMPT,
      entry ? "" : "This app cannot ship code changes yet: offer only the catalog action.",
    ]
      .filter(Boolean)
      .join("\n"),
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
        ownerTurnedDownUnderSameConditions: feedback.turnedDown[fingerprint(base)]?.count ?? 0,
      },
      rememberedRecovery: input.remembered,
      ownerPreferences: preferences.map((p, i) => ({ ref: prefRef(i), statement: p.statement })),
      pastDecisions: feedback.recent,
      context: context.map((c, i) => ({
        ref: ctxRef(i),
        kind: c.kind,
        label: c.label,
        detail: c.detail,
        helpedAVerifiedFixBefore: c.helpedBefore,
        possiblyStale: c.stale,
      })),
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
  const cited = new Map<string, { preferenceRefs: string[]; againstPreferenceRefs: string[]; contextRefs: string[] }>();
  const citesOf = (raw: unknown) => ({
    preferenceRefs: judged(raw, "honours"),
    againstPreferenceRefs: judged(raw, "against"),
    contextRefs: refsOf(raw, "contextRefs"),
  });
  if (usesBase) cited.set(base.key, citesOf(usesBase));
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
      cited.set(key, citesOf(raw));
      if (raw.recommended === true) flagged.push(key);
    } catch {
      dropped++;
    }
  }

  // The catalog action keeps its rule-based recommendation (memory and permissions depend on it); otherwise
  // the model's pick among the code changes stands, then the most confident one. Preferences and past
  // decisions may then move it (learning/rules.ts).
  const drafts = options.slice(1);
  const rulePick = baseSupported
    ? base.key
    : (flagged.find((key) => key !== base.key) ??
      drafts.reduce<ProposalOption | null>((best, o) => (!best || o.confidence > best.confidence ? o : best), null)
        ?.key ??
      null);
  const { choice, notes: learned } = settle(options, flagged, cited, rulePick);

  const notes = [
    `${options.length} fix${options.length === 1 ? "" : "es"} offered (${fixesModelId()}).`,
    dropped ? `${dropped} suggestion(s) were not offered: ${entry ? "incomplete, over the limit of four, or outside the catalog's constraints" : "this app has no pull request action in its catalog, so code changes cannot be approved yet"}.` : "",
    choice.key ? "" : "No fix is recommended: the facts don't point to the catalog action and no code change was offered.",
    ...learned,
  ];
  return { options: orderFixes(options), note: notes.filter(Boolean).join(" "), modelAnswered: true };
}
