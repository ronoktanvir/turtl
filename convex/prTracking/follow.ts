import { accessEnforced } from "../access";

// When turtl next reads a pull request it follows (convex/pullRequests.ts) or a preparation's (convex/onboarding/
// prepare.ts). Each row keeps its own next-sync time; the crons claim the rows whose time has come through an index,
// FOLLOW_BATCH at a time, and start one action per row, so every row gets its turn however many other accounts' rows
// there are (second review, finding 15). A row that never settles (a pull request left open for weeks) is read less
// and less often, down to once an hour; the owner's Refresh still reads it at once.
//
// The single-owner demo keeps reading every row at each tick of its cron, as before.

/** Due rows one claim takes; the cron claims again while a claim comes back full, up to FOLLOW_CLAIMS a tick. */
export const FOLLOW_BATCH = 100;
export const FOLLOW_CLAIMS = 10;
/** A claimed row is not claimed again for this long, while its action runs; the action sets the real next time. */
export const FOLLOW_LEASE_MS = 5 * 60_000;

/** How often a followed row is read, by how long turtl has followed it. The last step is the floor. */
export const FOLLOW_STEPS: readonly { after: number; every: number }[] = [
  { after: 10 * 60_000, every: 2 * 60_000 },
  { after: 60 * 60_000, every: 10 * 60_000 },
  { after: 24 * 60 * 60_000, every: 60 * 60_000 },
];

/**
 * When to read a row next. `since`: when turtl started following it; `every`: its cron's interval, which a row
 * followed for less than ten minutes (and every row in the demo) is read at.
 */
export function nextFollowAt(since: number, now: number, every: number): number {
  // The demo reads every row at every tick, as it always has.
  if (!accessEnforced()) return now;
  const age = now - since;
  const step = [...FOLLOW_STEPS].reverse().find((candidate) => age >= candidate.after);
  // A little early, so a row is due at the tick that comes a moment after its time.
  return now + Math.max(every, step?.every ?? every) - Math.min(5_000, every / 4);
}
