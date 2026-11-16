import { estimateCostUsd, PRICES_PER_MILLION } from "../routing/configs";

declare const process: { env: Record<string, string | undefined> };

// What one account may spend, and how a call's cost is counted. Pure apart from reading the two limits from the
// environment, so the tests load it as it is. The limits apply only in accounts mode (AUTH_REQUIRED=true).

export const MODEL_SPEND_LIMIT_ENV = "MODEL_SPEND_LIMIT_USD";
export const CODING_THREADS_ENV = "CODING_THREADS_PER_DAY";
export const DEFAULT_MODEL_SPEND_LIMIT_USD = 20;
export const DEFAULT_CODING_THREADS_PER_DAY = 5;
/** What reading one project's customer reports may cost in a day, apart from the account's allowance (finding 5). */
export const DEFAULT_INTAKE_SPEND_PER_DAY_USD = 0.5;
/** New cases customer reports may open on one project in a day. */
export const DEFAULT_INTAKE_CASES_PER_DAY = 5;
// Deployment-wide ceilings (finding 7): every limit above is per account or per project, so without these a script
// that makes accounts multiplies them.
export const DEFAULT_NEW_ACCOUNTS_PER_HOUR = 20;
export const DEFAULT_NEW_ACCOUNTS_PER_DAY = 100;
export const DEFAULT_DEPLOYMENT_MODEL_SPEND_PER_DAY_USD = 25;
export const DEFAULT_PROJECTS_PER_ACCOUNT = 10;
export const DEFAULT_INTAKE_KEYS_PER_PROJECT = 3;
// Each account's share of the deployment's day (finding 12): without it one account reaches the deployment's ceiling
// alone and no other owner gets a diagnosis until the next day. Its own calls and its projects' customer reports have
// separate shares, so a customer cannot use up what diagnosing the owner's outages needs.
export const DEFAULT_ACCOUNT_MODEL_SPEND_PER_DAY_USD = 2.5;
export const DEFAULT_ACCOUNT_INTAKE_SPEND_PER_DAY_USD = 1;
// The last part of the deployment's day is kept for finding the cause of outages the monitor found, and only for
// accounts that have used little of the day (finding 12). Any account can make the monitor raise cases at will (its own
// app, or its practice app), so a part kept for those cases alone would empty as fast as the rest; what makes it last
// is that each account may draw on it only while its own day is under DEFAULT_OUTAGE_RESERVE_ACCOUNT_USD. The part is a
// percentage of the ceiling, so it keeps its proportion when the operator moves the ceiling ($10 of the default $25).
export const DEFAULT_OUTAGE_RESERVE_PERCENT = 40;
export const DEFAULT_OUTAGE_RESERVE_ACCOUNT_USD = 0.5;
/**
 * What a model call counts for from the moment the gate lets it through until its cost comes back, when its caller
 * gives no estimate of its own (callEstimate). Without a hold a burst of calls started together would each pass the
 * check before any was counted, and one account could pass its share by as many calls as it can start at once. A call
 * whose cost never comes back (it failed) keeps its hold for the rest of the day.
 */
export const MODEL_CALL_HOLD_USD = 0.1;
/** The most one call's hold may be, whatever its caller estimates. */
export const MAX_CALL_HOLD_USD = 5;
/** Output tokens assumed for a call that sets no maximum of its own. */
export const ASSUMED_OUTPUT_TOKENS = 4_000;
/** A generous count of characters per token, so an estimate from a prompt's length is high rather than low. */
const CHARS_PER_TOKEN = 3;

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

/** Model spend on one project's customer reports (triage, and reading the cases they open) in a calendar day (UTC). */
export const intakeSpendPerDayUsd = () => positive(process.env.INTAKE_SPEND_PER_DAY_USD, DEFAULT_INTAKE_SPEND_PER_DAY_USD, false);

/** New cases customer reports may open on one project in a calendar day (UTC). */
export const intakeCasesPerDay = () => positive(process.env.INTAKE_CASES_PER_DAY, DEFAULT_INTAKE_CASES_PER_DAY, true);

/** New accounts the whole deployment makes in one clock hour (UTC), by any sign-in method. */
export const newAccountsPerHour = () => positive(process.env.NEW_ACCOUNTS_PER_HOUR, DEFAULT_NEW_ACCOUNTS_PER_HOUR, true);

/** New accounts the whole deployment makes in one calendar day (UTC). */
export const newAccountsPerDay = () => positive(process.env.NEW_ACCOUNTS_PER_DAY, DEFAULT_NEW_ACCOUNTS_PER_DAY, true);

/** Estimated model spend of every account together in one calendar day (UTC), in US dollars. */
export const deploymentModelSpendPerDayUsd = () => positive(process.env.DEPLOYMENT_MODEL_SPEND_PER_DAY_USD, DEFAULT_DEPLOYMENT_MODEL_SPEND_PER_DAY_USD, false);

/** Estimated model spend of one account's own calls in one calendar day (UTC): its share of the deployment's day. */
export const accountModelSpendPerDayUsd = () => positive(process.env.ACCOUNT_MODEL_SPEND_PER_DAY_USD, DEFAULT_ACCOUNT_MODEL_SPEND_PER_DAY_USD, false);

/** Estimated model spend on the customer reports of all one account's projects together in one calendar day (UTC). */
export const accountIntakeSpendPerDayUsd = () => positive(process.env.ACCOUNT_INTAKE_SPEND_PER_DAY_USD, DEFAULT_ACCOUNT_INTAKE_SPEND_PER_DAY_USD, false);

/** The percentage of the deployment's day, at its end, kept for finding the cause of outages the monitor found. 0 keeps
 * none, 100 keeps the whole day for them. */
export const outageReservePercent = () => {
  const raw = process.env.OUTAGE_RESERVE_PERCENT;
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_OUTAGE_RESERVE_PERCENT;
};

/** Only an account whose own calls cost less than this today may draw on the outage reserve. */
export const outageReserveAccountUsd = () => positive(process.env.OUTAGE_RESERVE_ACCOUNT_USD, DEFAULT_OUTAGE_RESERVE_ACCOUNT_USD, false);

/** Projects one account may have. */
export const projectsPerAccount = () => positive(process.env.PROJECTS_PER_ACCOUNT, DEFAULT_PROJECTS_PER_ACCOUNT, true);

/** Intake keys one project may have accepting reports at once. */
export const intakeKeysPerProject = () => positive(process.env.INTAKE_KEYS_PER_PROJECT, DEFAULT_INTAKE_KEYS_PER_PROJECT, true);

export const hourKey = (at: number) => new Date(at).toISOString().slice(0, 13);

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

/**
 * The most a call is likely to cost, from what is about to be sent: its prompt's length and the most it may write.
 * The gate holds this much against the account's day while the call runs (convex/consent/gate.ts).
 */
export function callEstimate(model: string, promptChars: number, maxOutputTokens = ASSUMED_OUTPUT_TOKENS): number {
  return modelCost(model, { inputTokens: Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN), outputTokens: Math.max(0, maxOutputTokens) });
}

export const spendRefusal = {
  overLimit: (limitUsd: number, at: number) =>
    `this account has used its ${dollars(limitUsd)} of AI for ${monthLabel(monthKey(at))}, so no model was asked; it starts again on ${nextMonthStart(at)}`,
  threadCap: (cap: number) =>
    `this account has already started ${cap} code change${cap === 1 ? "" : "s"} today, the most for one day, so Capy was not asked; it can start more tomorrow`,
  intakeSpent: (limitUsd: number) =>
    `this project has used today's ${dollars(limitUsd)} of AI for reading customer reports, so no model was asked; it starts again tomorrow`,
  intakeCases: (cap: number) =>
    `Kept, but no case was opened: customer reports have already opened ${cap} case${cap === 1 ? "" : "s"} on this project today, the most for one day. Reports that match an open case still join it, and new cases open again tomorrow.`,
  deploymentSpent: () => "turtl has reached the most AI it uses in one day across everyone, so no model was asked; it starts again tomorrow",
  accountDaySpent: (limitUsd: number) =>
    `this account has used today's ${dollars(limitUsd)} of AI, the most one account uses in a day, so no model was asked; it starts again tomorrow`,
  accountIntakeSpent: (limitUsd: number) =>
    `this account's projects have used today's ${dollars(limitUsd)} of AI for reading customer reports, so no model was asked; it starts again tomorrow`,
  reserveKept: () => "turtl is keeping the rest of today's AI for finding the cause of outages, so no model was asked; it starts again tomorrow",
  reserveUsed: (underUsd: number) =>
    `turtl is keeping the rest of today's AI for outages on accounts that have used less than ${dollars(underUsd)} of it today, and this account has used more, so no model was asked; it starts again tomorrow`,
};

/** What a person reads when a deployment-wide ceiling or a cap refuses them. Shown as written, so whole sentences. */
export const ceilingRefusal = {
  accountsThisHour: "turtl is making a lot of new accounts right now, so it isn't making more this hour. Try again in an hour.",
  accountsToday: "turtl has made as many new accounts as it makes in one day, so it isn't making more today. Try again tomorrow.",
  projects: (cap: number) => `This account already has ${cap} project${cap === 1 ? "" : "s"}, the most one account can have. Contact support if you need more.`,
  intakeKeys: (cap: number) => `This project already has ${cap} report key${cap === 1 ? "" : "s"} in use, the most one project can have. Stop one from taking reports before making another.`,
};
