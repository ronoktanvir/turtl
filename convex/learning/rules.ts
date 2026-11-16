import type { ProposalOption } from "../constants";

// Pure rules for preferences and feedback, kept apart from Convex so tests can load them directly.
// A preference is what the owner said matters. It may steer which offered fix is recommended and is cited
// when it does, but it is never evidence: it cannot make a fix recommended that the facts don't support,
// it never enters the facts a recovery memory's conditions or a permission are checked against, and it
// never approves anything.

export type Facts = Record<string, string | number | boolean>;

export const CONDITION_KEYS = ["journey.failedStep", "journey.errorCode", "flags.recommendationsEnabled"] as const;

// Which case conditions count as "the same": the symptom signature and the facts that shaped the diagnosis.
export function conditionsOf(signature: string | undefined, facts: Facts | null): { key: string; text: string } {
  const present = CONDITION_KEYS.filter((key) => facts && key in facts);
  const key = [signature ?? "no-signature", ...present.map((k) => `${k}=${JSON.stringify(facts![k])}`)].join("|");
  const step = facts?.["journey.failedStep"];
  const code = facts?.["journey.errorCode"];
  const flag = facts?.["flags.recommendationsEnabled"];
  const text =
    typeof step === "string" && step !== "none"
      ? `the check failed at the "${step}" step${typeof code === "string" && code !== "none" ? ` with ${code}` : ""}${typeof flag === "boolean" ? `, with recommendations ${flag ? "on" : "off"}` : ""}`
      : "the same symptoms";
  return { key, text };
}

// What makes two offered fixes "the same option" across cases: the catalog action and its values, or, for
// a code change whose words differ every time, its delivery and kind.
export function fingerprint(option: Pick<ProposalOption, "actionType" | "parameters" | "delivery" | "kind">): string {
  if (option.delivery === "pull_request") return `pull_request:${option.kind}`;
  const values = [...option.parameters]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name}=${JSON.stringify(p.value)}`)
    .join(",");
  return `${option.actionType}:${values}`;
}

export type TurnedDown = Record<string, { count: number; notes: string[]; title: string }>;

// Folds decisions under the same conditions into how often each option was turned down: declined while
// recommended, passed over for another fix, or stopped after approval.
export function turnedDownFrom(
  decisions: { turnedDownFingerprint?: string; turnedDownTitle?: string; note?: string }[],
): TurnedDown {
  const result: TurnedDown = {};
  for (const decision of decisions) {
    if (!decision.turnedDownFingerprint) continue;
    const entry = (result[decision.turnedDownFingerprint] ??= { count: 0, notes: [], title: decision.turnedDownTitle ?? "" });
    entry.count++;
    if (decision.note) entry.notes.push(decision.note);
  }
  return result;
}

export const TURNED_DOWN_LIMIT = 2;

export type Candidate = {
  key: string;
  fingerprint: string;
  // Whether the facts allow recommending it at all. A preference cannot change this.
  supported: boolean;
  confidence: number;
  modelFlagged: boolean;
  // Preferences this option honours, and those it goes against, as the model judged them.
  preferenceIds: string[];
  againstPreferenceIds?: string[];
};

export type Recommendation = {
  key: string | null;
  reason: "rules" | "preference" | "feedback" | "kept_despite_feedback" | "none";
  replacedKey?: string;
};

// The final pick. Starts from the rule-based pick. A preference then steers it: to another supported option
// the model recommended because it honours a preference, or, when the pick goes against a preference, to a
// supported option that honours that preference instead. Last, an option turned down twice under the same
// conditions is refused when any other supported option exists.
export function recommend(input: { candidates: Candidate[]; rulePick: string | null; turnedDown: TurnedDown }): Recommendation {
  const { candidates, turnedDown } = input;
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  let key = input.rulePick && byKey.get(input.rulePick)?.supported ? input.rulePick : null;
  let reason: Recommendation["reason"] = key ? "rules" : "none";
  let replacedKey: string | undefined;
  const against = (key ? byKey.get(key)?.againstPreferenceIds : undefined) ?? [];
  const steer =
    candidates.find((c) => c.modelFlagged && c.supported && c.preferenceIds.length > 0 && c.key !== key && !c.againstPreferenceIds?.length) ??
    (against.length
      ? candidates
          .filter((c) => c.supported && c.key !== key && !c.againstPreferenceIds?.length && c.preferenceIds.some((id) => against.includes(id)))
          .sort((a, b) => Number(b.modelFlagged) - Number(a.modelFlagged) || b.confidence - a.confidence)[0]
      : undefined);
  if (steer) {
    replacedKey = key ?? undefined;
    key = steer.key;
    reason = "preference";
  }
  const demoted = (c: Candidate) => (turnedDown[c.fingerprint]?.count ?? 0) >= TURNED_DOWN_LIMIT;
  const current = key ? byKey.get(key) : undefined;
  if (current && demoted(current)) {
    const alternative = candidates
      .filter((c) => c.supported && !demoted(c) && c.key !== current.key)
      .sort((a, b) => Number(b.modelFlagged) - Number(a.modelFlagged) || b.confidence - a.confidence)[0];
    if (alternative) return { key: alternative.key, reason: "feedback", replacedKey: current.key };
    return { key: current.key, reason: "kept_despite_feedback" };
  }
  return replacedKey ? { key, reason, replacedKey } : { key, reason };
}

// The plain sentence a fix carries about how the owner decided similar cases before.
export function pastDecisionLine(
  entry: TurnedDown[string] | undefined,
  conditionsText: string,
  role: "demoted" | "kept" | "other",
): string | undefined {
  if (!entry?.count) return undefined;
  const times = entry.count === 1 ? "once" : entry.count === 2 ? "twice" : `${entry.count} times`;
  const quoted = entry.notes.slice(-2).map((n) => `"${n}"`).join(" and ");
  const said = entry.notes.length ? ` You said: ${quoted}${/[.!?]"$/.test(quoted) ? "" : "."}` : "";
  const base = `You turned this down ${times} before when ${conditionsText}.${said}`;
  if (role === "demoted") return `${base} So turtl does not recommend it this time.`;
  if (role === "kept") return `${base} turtl still recommends it because no other fix on offer fits the facts. Nothing runs until you approve.`;
  return base;
}
