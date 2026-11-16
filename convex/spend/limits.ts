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
// New accounts come in three ways, each with its own ceilings (finding 12), so a script of throwaway password sign-ups
// fills only the first: password sign-ups before their address is confirmed; password accounts confirming it; and
// Apple and GitHub sign-ups (the NEW_ACCOUNTS ones above).
export const DEFAULT_PASSWORD_SIGNUPS_PER_HOUR = 40;
export const DEFAULT_PASSWORD_SIGNUPS_PER_DAY = 200;
export const DEFAULT_CONFIRMED_SIGNUPS_PER_HOUR = 20;
export const DEFAULT_CONFIRMED_SIGNUPS_PER_DAY = 100;
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
// And only for real outages on established projects (third review, finding 19): any account can make the monitor raise
// cases at will by breaking its practice app, so a practice app never draws on it, nor a project whose checks had not
// been passing for a day before this failure, nor an account made in the last two weeks.
export const DEFAULT_OUTAGE_RESERVE_STEADY_HOURS = 24;
export const DEFAULT_OUTAGE_RESERVE_ACCOUNT_AGE_DAYS = 14;
/**
 * What finding the cause of practice-app cases may cost one account in a day, within its own share (fourth review,
 * finding 23: beside the share it was $2 more room in the shared day for every account): a practice app has no
 * customers and nothing is down. Enough for the ten breaks a day the practice app allows, each explained by AI (a
 * diagnosis, the fixes on offer and a look for a broader cause, about $0.13 each), and no more.
 */
export const DEFAULT_PRACTICE_AI_PER_DAY_USD = 2;
/**
 * What finding the cause of an owner's own outages may cost in a day once the shared day has nothing left for it,
 * outside the shared day (fourth review, finding 23): however new the owner and whatever every other account has
 * spent, an outage turtl's checks found on the owner's own real project is diagnosed. With the default models one
 * outage costs about $0.35 at ordinary sizes (a quick and a careful diagnosis, a council of three and its summary, the
 * fixes on offer) and at most about $1.10 (the diagnosis's $0.50 budget, the council's $0.50 limit, the fixes): this
 * covers the most.
 */
export const DEFAULT_OUTAGE_FLOOR_PER_DAY_USD = 1.25;
/**
 * What a model call counts for from the moment the gate lets it through until its cost comes back, when its caller
 * gives no estimate of its own (callEstimate). Without a hold a burst of calls started together would each pass the
 * check before any was counted, and one account could pass its share by as many calls as it can start at once. A call
 * whose cost never comes back (it failed) keeps its hold for the rest of the day.
 */
export const MODEL_CALL_HOLD_USD = 0.1;
/** The most one call's hold may be, whatever its caller estimates. */
export const MAX_CALL_HOLD_USD = 5;
/**
 * The most a model call writes when its caller sets no smaller maximum. askJson (convex/fixOptions.ts) and the
 * structural review send it as their maximum, so their estimate is an upper bound: a prompt that coaxes a model into a
 * very long answer cannot make one call cost more than it was held at. Generous, since reasoning counts toward it.
 */
export const ASSUMED_OUTPUT_TOKENS = 16_000;
/**
 * Tokens added to a call beyond its texts: each message's role and separators, and the reply's start. A few per message
 * in every chat format; this is generous.
 */
const FRAMING_TOKENS_PER_TEXT = 8;
const FRAMING_TOKENS = 16;

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

/** New accounts the whole deployment makes with Sign in with Apple or GitHub in one clock hour (UTC). */
export const newAccountsPerHour = () => positive(process.env.NEW_ACCOUNTS_PER_HOUR, DEFAULT_NEW_ACCOUNTS_PER_HOUR, true);

/** New accounts the whole deployment makes with Sign in with Apple or GitHub in one calendar day (UTC). */
export const newAccountsPerDay = () => positive(process.env.NEW_ACCOUNTS_PER_DAY, DEFAULT_NEW_ACCOUNTS_PER_DAY, true);

/** Password sign-ups (accounts that must still confirm their address) the deployment takes in one clock hour (UTC). */
export const passwordSignUpsPerHour = () => positive(process.env.PASSWORD_SIGNUPS_PER_HOUR, DEFAULT_PASSWORD_SIGNUPS_PER_HOUR, true);

/** Password sign-ups the deployment takes in one calendar day (UTC). */
export const passwordSignUpsPerDay = () => positive(process.env.PASSWORD_SIGNUPS_PER_DAY, DEFAULT_PASSWORD_SIGNUPS_PER_DAY, true);

/** Password accounts the deployment lets confirm their address in one clock hour (UTC). */
export const confirmedSignUpsPerHour = () => positive(process.env.CONFIRMED_SIGNUPS_PER_HOUR, DEFAULT_CONFIRMED_SIGNUPS_PER_HOUR, true);

/** Password accounts the deployment lets confirm their address in one calendar day (UTC). */
export const confirmedSignUpsPerDay = () => positive(process.env.CONFIRMED_SIGNUPS_PER_DAY, DEFAULT_CONFIRMED_SIGNUPS_PER_DAY, true);

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

/** How long a project's check must have been passing before it failed for its case to draw on the outage reserve. */
export const outageReserveSteadyMs = () => positive(process.env.OUTAGE_RESERVE_STEADY_HOURS, DEFAULT_OUTAGE_RESERVE_STEADY_HOURS, false) * 3_600_000;

/** How old an account must be for its outages to draw on the outage reserve. */
export const outageReserveAccountAgeMs = () => positive(process.env.OUTAGE_RESERVE_ACCOUNT_AGE_DAYS, DEFAULT_OUTAGE_RESERVE_ACCOUNT_AGE_DAYS, false) * 86_400_000;

/** What one account's practice-app cases may spend on models in a calendar day (UTC). */
export const practiceAiPerDayUsd = () => positive(process.env.PRACTICE_AI_PER_DAY_USD, DEFAULT_PRACTICE_AI_PER_DAY_USD, false);

/** What one account's own outages may cost in a day past the shared day: the floor no other account can use up. */
export const outageFloorPerDayUsd = () => positive(process.env.OUTAGE_FLOOR_PER_DAY_USD, DEFAULT_OUTAGE_FLOOR_PER_DAY_USD, false);

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

const utf8 = new TextEncoder();

/**
 * The most a call can cost, from what is about to be sent: its texts and the most it may write. The gate holds this
 * much against the account's day while the call runs (convex/consent/gate.ts), so it must not be low for any text.
 *
 * Input tokens are counted as the texts' UTF-8 bytes. No tokenizer turns text into more tokens than that: the
 * byte-level BPE of OpenAI and Anthropic models makes each token of at least one byte, and Gemini's makes each of at
 * least one character, which is at least one byte. Characters were not enough (third review): dense text such as
 * Chinese or emoji takes three or four bytes a character and can take a token for each byte. English is about four
 * bytes a token, so for it this is four times what a call reads; the hold is returned when the call reports its cost.
 */
export function callEstimate(model: string, texts: string | readonly string[], maxOutputTokens = ASSUMED_OUTPUT_TOKENS): number {
  const all = typeof texts === "string" ? [texts] : texts;
  const inputTokens = all.reduce((sum, text) => sum + utf8.encode(text).length + FRAMING_TOKENS_PER_TEXT, FRAMING_TOKENS);
  return modelCost(model, { inputTokens, outputTokens: Math.max(0, maxOutputTokens) });
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
  reserveNotSteady: (hours: number) =>
    `turtl is keeping the rest of today's AI for outages on apps whose checks had been passing for ${hours === 24 ? "a day" : `${hours} hours`} before they failed, and this one's had not, so no model was asked; it starts again tomorrow`,
  reserveNewAccount: (days: number) =>
    `turtl is keeping the rest of today's AI for outages on accounts more than ${days} days old, so no model was asked; it starts again tomorrow`,
  floorUsed: (floorUsd: number) =>
    `this account has used the ${dollars(floorUsd)} turtl keeps for it each day for finding the cause of its own outages, and no other AI is left for it today, so no model was asked; it starts again tomorrow`,
  practiceSpent: (limitUsd: number) =>
    `this account has used today's ${dollars(limitUsd)} of AI for its practice app, so no model was asked; it starts again tomorrow`,
};

/** What a person reads when a deployment-wide ceiling or a cap refuses them. Shown as written, so whole sentences. */
export const ceilingRefusal = {
  accountsThisHour: "turtl is making a lot of new accounts right now, so it isn't making more this hour. Try again in an hour.",
  accountsToday: "turtl has made as many new accounts as it makes in one day, so it isn't making more today. Try again tomorrow.",
  passwordSignUpsThisHour: "turtl is making a lot of new accounts with an email address right now, so it isn't making more this hour. Try again in an hour, or sign up with Apple or GitHub.",
  passwordSignUpsToday: "turtl has made as many new accounts with an email address as it makes in one day. Try again tomorrow, or sign up with Apple or GitHub.",
  confirmationsThisHour: "turtl is confirming a lot of new accounts right now, so it can't confirm yours this hour. Your code still works: try again in an hour.",
  confirmationsToday: "turtl has confirmed as many new accounts as it does in one day, so it can't confirm yours today. Try again tomorrow, and ask for a new code if this one has stopped working.",
  projects: (cap: number) => `This account already has ${cap} project${cap === 1 ? "" : "s"}, the most one account can have. Contact support if you need more.`,
  intakeKeys: (cap: number) => `This project already has ${cap} report key${cap === 1 ? "" : "s"} in use, the most one project can have. Stop one from taking reports before making another.`,
};
