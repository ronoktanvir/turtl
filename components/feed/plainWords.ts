import { timeAgo } from "./cards";

// Turns stored facts, checks and machine text into sentences an owner reads at a glance. Content only.

type Value = string | number | boolean | null;
export type Check = { field: string; operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; value: Value };

const STEPS: Record<string, string> = { recommendations: "recommendations", submit_booking: "submit", none: "no" };
const ERRORS: Record<string, string> = {
  RECOMMENDATIONS_TIMEOUT: "a recommendations timeout",
  BOOKING_STORE_UNAVAILABLE: "a booking store error",
};
const FLAGS: Record<string, string> = { recommendationsEnabled: "recommendations" };

export const shortVersion = (value: Value) => (typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : String(value));
export const flagName = (flag: string) => FLAGS[flag] ?? flag;

const pad = (n: number) => String(n).padStart(2, "0");
const localTime = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// One check as a sentence: what holds when the check matches. Keys with no wording keep their raw form.
export function checkInWords(check: Check): string {
  const { field, operator, value } = check;
  const is = operator === "eq";
  const not = operator === "neq";
  if (is || not) {
    switch (field) {
      case "journey.verdict":
        if (value === "failed") return is ? "The booking check is failing" : "The booking check is not failing";
        if (value === "passed") return is ? "The booking check passes" : "The booking check does not pass";
        break;
      case "journey.failedStep":
        if (typeof value === "string") {
          const step = STEPS[value] ?? value;
          return is ? `It fails at the ${step} step` : `It does not fail at the ${step} step`;
        }
        break;
      case "journey.errorCode":
        if (typeof value === "string") {
          const error = ERRORS[value] ?? value;
          return is ? `The error is ${error}` : `The error is not ${error}`;
        }
        break;
      case "flags.recommendationsEnabled":
        if (typeof value === "boolean") return `Recommendations are ${value === is ? "turned on" : "turned off"}`;
        break;
      case "health.ok":
        if (typeof value === "boolean") return value === is ? "The booking app's server answers" : "The booking app's server does not answer";
        break;
      case "app.revision":
        return is ? `The booking app is still on version ${shortVersion(value)}` : `The booking app is on a version other than ${shortVersion(value)}`;
      case "errors.topCode":
        if (typeof value === "string") return `The most common booking error ${is ? "is" : "is not"} ${ERRORS[value] ?? value}`;
        break;
    }
  }
  const words = { eq: "equals", neq: "does not equal", lt: "is less than", lte: "is at most", gt: "is greater than", gte: "is at least" };
  return `${field} ${words[operator]} ${JSON.stringify(value)}`;
}

const OPPOSITE: Record<Check["operator"], Check["operator"]> = { eq: "neq", neq: "eq", lt: "gte", gte: "lt", gt: "lte", lte: "gt" };

// A not-when check that only says "this condition no longer holds" adds nothing for the owner.
export const isMirror = (notWhen: Check, conditions: readonly Check[]) =>
  conditions.some((c) => c.field === notWhen.field && OPPOSITE[c.operator] === notWhen.operator && c.value === notWhen.value);

// Reads the "Required condition failed: <field> <comparison> <value>; observed <x>." lines recall records and
// says what is different this time, in words.
export function differencesInWords(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^Required condition failed: (\S+) .+; observed (.+)\.$/.exec(line.trim());
    if (!match) continue;
    let observed: Value;
    try {
      observed = JSON.parse(match[2]) as Value;
    } catch {
      continue;
    }
    out.push(
      match[1] === "app.revision"
        ? `The booking app is now on version ${shortVersion(observed)}`
        : checkInWords({ field: match[1], operator: "eq", value: observed }),
    );
  }
  return [...new Set(out)];
}

// Owner-facing text never shows a database id, a full commit hash or an ISO time.
export function plainText(text: string, now: number): string {
  return text
    .replace(/Recovery memory [a-z0-9]{20,}/g, "A saved recovery")
    .replace(/recovery memory [a-z0-9]{20,}/g, "a saved recovery")
    .replace(/Verification and owner approval are still required\./g, "It is still checked after the change.")
    .replace(/Owner approval and a new verification are still required\./g, "The service is checked again after the change.")
    .replace(/booking_screen_on_device/g, "the booking screen on a real device")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, (iso) => {
      const ts = Date.parse(iso);
      return `${timeAgo(ts, now)} (${localTime(ts)})`;
    })
    .replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 7));
}
