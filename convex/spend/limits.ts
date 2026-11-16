import { estimateCostUsd, PRICES_PER_MILLION } from "../routing/configs";

declare const process: { env: Record<string, string | undefined> };

// What one account may spend, and how a call's cost is counted. Pure apart from reading the two limits from the
// environment, so the tests load it as it is. The limits apply only in accounts mode (AUTH_REQUIRED=true).

export const MODEL_SPEND_LIMIT_ENV = "MODEL_SPEND_LIMIT_USD";
export const CODING_THREADS_ENV = "CODING_THREADS_PER_DAY";
export const DEFAULT_MODEL_SPEND_LIMIT_USD = 20;
export const DEFAULT_CODING_THREADS_PER_DAY = 5;

/** A flat estimate for one speech-to-text or text-to-speech call, which report no token counts. */
export const VOICE_CALL_ESTIMATE_USD = 0.01;

const positive = (raw: string | undefined, fallback: number, whole: boolean) => {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value <= 0) return fallback;
  return whole ? Math.floor(value) || fallback : value;
};

/** Model spend one account may reach in a calendar month (UTC), in US dollars. */
export const modelSpendLimitUsd = () => positive(process.env.MODEL_SPEND_LIMIT_USD, DEFAULT_MODEL_SPEND_LIMIT_USD, false);

/** Coding-agent threads (Capy) one account may start in a calendar day (UTC). */
export const codingThreadsPerDay = () => positive(process.env.CODING_THREADS_PER_DAY, DEFAULT_CODING_THREADS_PER_DAY, true);

export const monthKey = (at: number) => new Date(at).toISOString().slice(0, 7);
export const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "November 2026" for "2026-11". */
export function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

/** "1 December" for any moment in November. */
export function nextMonthStart(at: number): string {
  const month = new Date(at).getUTCMonth();
  return `1 ${MONTHS[(month + 1) % 12]}`;
}

export const dollars = (value: number) => `$${value.toFixed(2)}`;

// A model with no list price is counted at the dearest price on the list, so an unpriced model cannot slip past the limit.
const DEAREST = Object.values(PRICES_PER_MILLION).reduce(
  (worst, price) => ({ input: Math.max(worst.input, price.input), output: Math.max(worst.output, price.output) }),
  { input: 0, output: 0 },
);

/** The estimated cost of one call from the tokens it reports; 0 when it reports none. */
export function modelCost(model: string, usage: { inputTokens: number; outputTokens: number } | undefined | null): number {
  if (!usage) return 0;
  const listed = estimateCostUsd(model, usage.inputTokens, usage.outputTokens);
  return listed ?? (usage.inputTokens * DEAREST.input + usage.outputTokens * DEAREST.output) / 1_000_000;
}

export const spendRefusal = {
  overLimit: (limitUsd: number, at: number) =>
    `this account has used its ${dollars(limitUsd)} of AI for ${monthLabel(monthKey(at))}, so no model was asked; it starts again on ${nextMonthStart(at)}`,
  threadCap: (cap: number) =>
    `this account has already started ${cap} code change${cap === 1 ? "" : "s"} today, the most for one day, so Capy was not asked; it can start more tomorrow`,
};
