import type { PracticeFailure } from "../practice/types";
import type { CaseDetail, FixOption } from "../types";
import type { ProjectSeed, StepSeed } from "./content";

// The example build's practice app: the project, the issue each failure opens, and the plan its fix runs. It mirrors
// what a live backend does (convex/practice), with the same names and words, so the screens can be reviewed without one.

export const PRACTICE_PROJECT_ID = "practice";

export const practiceProject: ProjectSeed = {
  id: PRACTICE_PROJECT_ID,
  name: "Practice booking app",
  approvals: "you",
  practice: true,
};

const fixes: Record<PracticeFailure, FixOption> = {
  recommendations: {
    key: "turn_off_recommendations",
    title: "Turn off recommendations",
    kind: "recovery",
    recommended: true,
    delivery: "action",
    why: [{ text: "Booking waits for service suggestions while they are turned on, and the suggestions are timing out, so bookings never get saved. Turning off recommendations removes that wait, so customers can finish booking again." }],
    whatChanges: "Turns off service suggestions in the booking app, so booking stops waiting for the recommendations provider.",
    whatMightBeLost: "Customers won't see suggested services until recommendations are turned back on. Bookings already made don't change, and the slow provider itself is not fixed.",
    howChecked: "turtl checks that the booking app answers, that recommendations read as off, and then runs the booking check: a test booking must be saved and match its confirmation.",
    usersCantNow: "Customers can't finish a booking: the booking check fails while waiting for recommendations.",
    sends: { kind: "action", name: "Turn off recommendations", description: "Sets the practice app's recommendationsEnabled switch to false, so booking stops waiting for suggested services. Reversible: set it back to true.", target: "Your practice app's recommendations switch", values: [{ name: "flag", value: "\"recommendationsEnabled\"" }, { name: "value", value: "false" }] },
  },
  booking_store: {
    key: "use_backup_store",
    title: "Save bookings to the backup store",
    kind: "recovery",
    recommended: true,
    delivery: "action",
    why: [{ text: "The booking store is refusing new bookings, so every booking fails at the last step. Saving new bookings to the backup store lets customers finish booking again while the main store is down." }],
    whatChanges: "Saves new bookings to the booking app's backup store, so booking works again while the main booking store is down.",
    whatMightBeLost: "New bookings stay in the backup store until it is switched off again. The main booking store itself is not fixed.",
    howChecked: "turtl checks that the booking app answers, that the backup store reads as on, and then runs the booking check: a test booking must be saved and match its confirmation.",
    usersCantNow: "Customers can't finish a booking: the booking check fails when it saves the booking.",
    sends: { kind: "action", name: "Save bookings to the backup store", description: "Sets the practice app's backupStoreEnabled switch to true, so new bookings are saved to its backup store while the main one is down. Reversible: set it back to false.", target: "Your practice app's backup store switch", values: [{ name: "flag", value: "\"backupStoreEnabled\"" }, { name: "value", value: "true" }] },
  },
};

/** The issue a failure opens, as turtl's checks find it. */
export function practiceCase(failure: PracticeFailure, number: number, at: number): CaseDetail {
  const recommendations = failure === "recommendations";
  const id = `practice-${number}`;
  return {
    id,
    projectId: PRACTICE_PROJECT_ID,
    type: "fix",
    number,
    title: "Booking is failing",
    category: "broken_journey",
    status: "needs_approval",
    health: "affected",
    happenedAt: at,
    summary: recommendations
      ? "Bookings stop while the practice app waits for service suggestions that never come."
      : "Bookings stop at the last step: the practice app's booking store refuses to save them.",
    overview: [
      { kind: "paragraph", spans: [{ text: "turtl's regular booking check failed on your practice app, so it opened this issue. The practice app has no customers, so nobody was turned away: only turtl's test booking failed." }] },
      {
        kind: "visualization",
        title: "Where a booking stops",
        viz: {
          type: "journey",
          steps: [
            { label: "Choose a service", state: "passed" },
            { label: "Get recommendations", state: recommendations ? "failed" : "not_reached" },
            { label: "Save the booking", state: recommendations ? "not_reached" : "failed" },
            { label: "Confirm it was saved", state: "not_reached" },
          ],
        },
      },
      {
        kind: "paragraph",
        spans: [{ text: recommendations ? "The suggestions took longer than their time limit, and booking waits for them before it saves, so the test booking was never saved." : "The booking store answered that it is unavailable, so the test booking was never saved. Suggestions were not asked for." }],
      },
    ],
    citations: [],
    logs: [
      { id: `${id}-check`, at, level: "error", source: "Booking check", text: recommendations ? "The booking check failed while waiting for recommendations: the provider timed out, so the booking was not saved." : "The booking check failed when it saved the booking: the booking store is unavailable." },
      { id: `${id}-health`, at: at + 400, level: "info", source: "Health check", text: "The practice app's server answered its health check." },
      { id: `${id}-cleanup`, at: at + 600, level: "info", source: "Booking check", text: "Deleted 0 test bookings. The practice app has no customers, so no customer booking failed." },
    ],
    code: [],
    screenshots: [],
    fixes: [fixes[failure]],
  };
}

export const practicePlans: Record<string, StepSeed[]> = {
  turn_off_recommendations: [
    { key: "switch", title: "Turn off recommendations", detail: "turtl sets the practice app's recommendations switch to off.", summary: "The practice app confirmed recommendations are off." },
    { key: "verify", title: "Run the booking check again", detail: "A test booking must be saved and match its confirmation.", summary: "The booking check passed: a test booking was saved and matched its confirmation." },
  ],
  use_backup_store: [
    { key: "switch", title: "Save bookings to the backup store", detail: "turtl sets the practice app's backup store switch to on.", summary: "The practice app confirmed new bookings go to the backup store." },
    { key: "verify", title: "Run the booking check again", detail: "A test booking must be saved and match its confirmation.", summary: "The booking check passed: a test booking was saved and matched its confirmation." },
  ],
};

export const practiceLearned: Record<string, string> = {
  turn_off_recommendations: "Turning off recommendations restored booking on the practice app. The slow suggestions are still slow.",
  use_backup_store: "Saving to the backup store restored booking on the practice app. The main booking store is still down.",
};
