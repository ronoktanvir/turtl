// A practice project, as the app sees it: the shape convex/practice/projects.ts (status) returns.

export type PracticeFailure = "recommendations" | "booking_store";

export type PracticeProject = {
  projectId: string;
  name: string;
  /** What stops a booking now, or null when the practice app works. */
  failure: PracticeFailure | null;
  brokenAt?: number;
  /** The open issue on it, if any, and where it is. */
  caseId?: string;
  caseStage?: "working" | "waiting" | "carrying_out";
  /** Still broken after an issue on this break closed unfixed (its fixes declined): turtl opens no new one until it works. */
  stalled?: boolean;
  /** How many more times the owner may break it today, and when that count starts again. */
  breaksLeft: number;
  breaksResetAt?: number;
  /** What an earlier fix left switched, for a practice app that works again. */
  note?: string;
};

export type Practice = {
  /** This account can have a practice app: accounts are on and the backend can run one. False in the demo. */
  available: boolean;
  breaksPerDay: number;
  project: PracticeProject | null;
};

/** The two failures, in the owner's words: what they pick on the Break sheet. */
export const FAILURE_WORDS: Record<PracticeFailure, { title: string; what: string }> = {
  recommendations: {
    title: "Recommendations time out",
    what: "Booking waits for service suggestions that never come, so no booking is saved.",
  },
  booking_store: {
    title: "Bookings fail to save",
    what: "The booking store stops taking bookings, so every booking fails at the last step.",
  },
};
