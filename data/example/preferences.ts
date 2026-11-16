import type { OwnerPreference, PreferenceSuggestion, Preferences } from "../types";

const seededAt = Date.parse("2026-11-14T18:00:00Z");
const saved = new Map<string, OwnerPreference[]>([
  ["listener-ladder", [{ id: "pref-answer-flow", statement: "Keep the answer flow the same, even if ranks take more work.", source: "settings", createdAt: seededAt }]],
]);
const heard = new Map<string, PreferenceSuggestion[]>([
  ["listener-ladder", [{ id: "suggestion-streaks", statement: "Don't reset players' streaks.", source: "decision_note", createdAt: seededAt + 3_600_000 }]],
]);
const settled = new Map<string, "saved" | "dismissed">();
let count = 0;

const wish = /\b(always|never|don't|don’t|do not|keep|make sure|i'd rather|i’d rather|prefer)\b/i;

export function statesWish(text: string): boolean {
  return wish.test(text);
}

export function restate(text: string): string {
  const sentence = text.trim().split(/(?<=[.!?])\s+/).find((part) => wish.test(part)) ?? text.trim();
  const plain = sentence
    .replace(/^(please|and|also|so|but)\s+/i, "")
    .replace(/^(i'd rather|i’d rather|i would rather|i prefer|i'd prefer|we prefer|prefer)\s+(to\s+|you\s+)?/i, "")
    .replace(/[.!?]+$/, "")
    .trim()
    .slice(0, 140);
  return plain ? plain[0].toUpperCase() + plain.slice(1) + "." : "";
}

export function list(projectId: string): Preferences {
  return { preferences: saved.get(projectId) ?? [], suggestions: heard.get(projectId) ?? [] };
}

function checked(statement: string): string {
  const text = statement.trim();
  if (!text) throw new Error("Write what matters to you before adding it.");
  if (text.length > 280) throw new Error("Keep it to 280 characters or fewer.");
  return text;
}

export function add(projectId: string, statement: string, source: OwnerPreference["source"] = "settings"): OwnerPreference {
  const text = checked(statement);
  count += 1;
  const preference: OwnerPreference = { id: "pref-" + count, statement: text, source, createdAt: Date.now() };
  saved.set(projectId, [...(saved.get(projectId) ?? []), preference]);
  return preference;
}

export function remove(projectId: string, preferenceId: string) {
  saved.set(projectId, (saved.get(projectId) ?? []).filter((p) => p.id !== preferenceId));
}

export function suggest(projectId: string, text: string, source: PreferenceSuggestion["source"]): PreferenceSuggestion | null {
  const statement = restate(text);
  if (!statement) return null;
  count += 1;
  const suggestion: PreferenceSuggestion = { id: "suggestion-" + count, statement, source, createdAt: Date.now() };
  heard.set(projectId, [...(heard.get(projectId) ?? []), suggestion]);
  return suggestion;
}

function pending(projectId: string, suggestionId: string): PreferenceSuggestion {
  const suggestion = (heard.get(projectId) ?? []).find((s) => s.id === suggestionId);
  if (!suggestion) throw new Error("This suggestion was already handled.");
  return suggestion;
}

function settle(projectId: string, suggestionId: string, outcome: "saved" | "dismissed") {
  heard.set(projectId, (heard.get(projectId) ?? []).filter((s) => s.id !== suggestionId));
  settled.set(suggestionId, outcome);
}

export function confirm(projectId: string, suggestionId: string, statement?: string): OwnerPreference {
  const suggestion = pending(projectId, suggestionId);
  const preference = add(projectId, statement?.trim() || suggestion.statement, suggestion.source);
  settle(projectId, suggestionId, "saved");
  return preference;
}

export function dismiss(projectId: string, suggestionId: string) {
  pending(projectId, suggestionId);
  settle(projectId, suggestionId, "dismissed");
}

export function status(suggestionId: string): "pending" | "saved" | "dismissed" {
  return settled.get(suggestionId) ?? "pending";
}
