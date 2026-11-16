import type { PracticeFailure } from "./schema";

declare const process: { env: Record<string, string | undefined> };

// The practice app's rules, free of Convex so the tests load them as they are.
//
// A practice project (convex/practice) is a project an account owns whose live app is a small booking app turtl runs
// itself, on this deployment's own site address under /practice/<project id>, answering only to that project's own
// control token. Its state is four switches. Two failures can be switched on by its owner, and turtl's ordinary action
// catalog can switch each one's recovery on: turning recommendations off, or saving bookings to the backup store.

export const PRACTICE_APP_NAME = "Practice booking app";
/** What the practice app reports as its revision. Its code never changes, so this is fixed. */
export const PRACTICE_REVISION = "practice-booking-v1";
/** The path the practice apps are served under, on this deployment's site address. */
export const PRACTICE_PREFIX = "/practice/";
export const DEFAULT_PRACTICE_BREAKS_PER_DAY = 10;

export type Switches = {
  recommendationsEnabled: boolean;
  providerTimeout: boolean;
  bookingStoreFailure: boolean;
  backupStoreEnabled: boolean;
};

/** A practice app as it is made, and as "Put it back" leaves it: everything works. */
export const WORKING: Switches = { recommendationsEnabled: true, providerTimeout: false, bookingStoreFailure: false, backupStoreEnabled: false };

/** Each failure the owner can choose: the whole state it leaves, so it fails whatever an earlier fix switched. */
export const BREAKS: Record<PracticeFailure, Switches> = {
  recommendations: { recommendationsEnabled: true, providerTimeout: true, bookingStoreFailure: false, backupStoreEnabled: false },
  booking_store: { recommendationsEnabled: true, providerTimeout: false, bookingStoreFailure: true, backupStoreEnabled: false },
};

export const FAILURES = Object.keys(BREAKS) as PracticeFailure[];

/** Which failure stops a booking now, or null when the booking journey works. The store failure comes first, as in the
 * booking demo: with it, the recommendations provider is never called. */
export function failureOf(switches: Switches): PracticeFailure | null {
  if (switches.bookingStoreFailure && !switches.backupStoreEnabled) return "booking_store";
  if (switches.recommendationsEnabled && switches.providerTimeout) return "recommendations";
  return null;
}

/** One line on what an earlier fix left switched, for an app that works again. */
export function noteOf(switches: Switches): string | null {
  if (failureOf(switches)) return null;
  if (!switches.recommendationsEnabled) return "Recommendations are off since turtl's last fix.";
  if (switches.bookingStoreFailure && switches.backupStoreEnabled) return "Bookings go to the backup store since turtl's last fix.";
  return null;
}

/** How many times one account may break its practice app in a UTC day. */
export function practiceBreaksPerDay(raw: string | undefined = process.env.PRACTICE_BREAKS_PER_DAY): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value < 1) return DEFAULT_PRACTICE_BREAKS_PER_DAY;
  return Math.floor(value);
}

export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Breaks used and left today, from the row's count. */
export function allowance(breaks: { day: string; count: number } | undefined, now: number, limit: number) {
  const day = dayOf(now);
  const used = breaks?.day === day ? breaks.count : 0;
  return { day, used, left: Math.max(0, limit - used) };
}

/** The practice app's address for a project: this deployment's site address, then /practice/<project id>. */
export function practiceBase(siteUrl: string, appId: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${PRACTICE_PREFIX}${appId}`;
}

/** A practice request's project id and endpoint, from its path, or null for a path that names neither. */
export function routeOf(pathname: string): { appId: string; endpoint: string } | null {
  if (!pathname.startsWith(PRACTICE_PREFIX)) return null;
  const parts = pathname.slice(PRACTICE_PREFIX.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { appId: parts[0], endpoint: parts[1] };
}

/** What the owner reads when turtl refuses, as whole sentences. */
export const PRACTICE_WORDS = {
  demo: "A practice app needs accounts, and this backend runs the single-owner demo.",
  notPractice: "That project is not a practice app.",
  noSite: "turtl can't run a practice app on this backend, because its own web address can't be watched.",
  alreadyBroken: "Your practice app is already broken. turtl notices within a minute or two and opens an issue under Fix.",
  caseOpen: "turtl is already working on an issue on your practice app. Finish it first: approve or decline its fixes under Fix.",
  caseOpenMend: "turtl is working on an issue on your practice app. Decline its fixes under Fix first if you want to put it back yourself.",
  limit: (limit: number) =>
    `You have broken your practice app ${limit} time${limit === 1 ? "" : "s"} today, the most for one day. You can break it again tomorrow.`,
};
