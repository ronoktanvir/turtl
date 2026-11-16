import type { Doc } from "../_generated/dataModel";
import type { Criterion } from "../constants";
import { CRITERIA } from "./client";

type Facts = Record<string, string | number | boolean>;

// The switches turtl knows how to offer as a recovery and how to check afterwards: a catalog action of type
// set_feature_flag whose "flag" parameter may name one of these, sent as { [flag]: value } (runner/handlers/plan.ts,
// authorize_and_execute.ts, verify.ts). The booking demo has the first. A practice app (convex/practice) has both.
// The recommendations switch's words are the ones the plan and verify steps always used, so the demo reads as before.

export type KnownSwitch = {
  flag: string;
  /** The value the recovery sets. */
  value: boolean;
  /** The option's key on a proposal. */
  key: string;
  criterion: Criterion;
  /** Whether the facts point at the failure this switch recovers from. */
  fits: (facts: Facts) => boolean;
  /** Why it would work, after the diagnosis's cause, when no model wrote the why. */
  reason: string;
  /** What the facts say, in plain words, for a fix the rule-based reading has no cause for (it reads the failure as
   * unknown). Only a switch whose failure has no rule of its own has one. */
  factsSay?: string;
  whatChanges: string;
  whatMightBeLost: string;
  /** How turtl checks it worked, without the sentence on the device check (plan.ts adds it where that is a criterion). */
  howChecked: string;
  proposed: { fits: string; doesNotFit: string };
  /** Verify's reading of the switch. */
  readAs: (value: boolean) => string;
  unreadable: string;
  sourceRef: string;
  /** Verify's summary once service is back: what is now true, and what is still broken. */
  restored: string;
  leftover: string;
  handoff: string;
};

const failed = (facts: Facts, step: string, code: string) =>
  facts["journey.verdict"] === "failed" && facts["journey.failedStep"] === step && facts["journey.errorCode"] === code;

export const SWITCHES: Record<string, KnownSwitch> = {
  recommendationsEnabled: {
    flag: "recommendationsEnabled",
    value: false,
    key: "turn_off_recommendations",
    criterion: CRITERIA.recommendationsOff,
    fits: (facts) => failed(facts, "recommendations", "RECOMMENDATIONS_TIMEOUT") && facts["flags.recommendationsEnabled"] === true,
    reason: "Turning off recommendations removes that wait, so customers can finish booking again.",
    whatChanges: "Turns off service suggestions in the booking app, so booking stops waiting for the recommendations provider.",
    whatMightBeLost: "Customers won't see suggested services until recommendations are turned back on. Bookings already made don't change, and the slow provider itself is not fixed.",
    howChecked: "turtl checks that the booking app answers, that recommendations read as off, and then runs the booking check: a test booking must be saved and match its confirmation.",
    proposed: { fits: "Proposed turning off recommendations to restore booking.", doesNotFit: "Proposed turning off recommendations, but the facts don't point to recommendations." },
    readAs: (value) => `Recommendations read as ${value ? "on" : "off"}.`,
    unreadable: "The recommendations flag could not be read",
    sourceRef: "GET /flags",
    restored: "recommendations are off",
    leftover: "The defect that let recommendations block booking is still in the code.",
    handoff: "Service is restored, not repaired: recommendations are off and the coupling is still in the code.",
  },
  backupStoreEnabled: {
    flag: "backupStoreEnabled",
    value: true,
    key: "use_backup_store",
    criterion: CRITERIA.backupStoreOn,
    fits: (facts) => failed(facts, "submit_booking", "BOOKING_STORE_UNAVAILABLE"),
    reason: "Saving new bookings to the backup store lets customers finish booking again while the main store is down.",
    factsSay: "The booking store answers that it is unavailable, so every booking fails when it is saved.",
    whatChanges: "Saves new bookings to the booking app's backup store, so booking works again while the main booking store is down.",
    whatMightBeLost: "New bookings stay in the backup store until it is switched off again. The main booking store itself is not fixed.",
    howChecked: "turtl checks that the booking app answers, that the backup store reads as on, and then runs the booking check: a test booking must be saved and match its confirmation.",
    proposed: { fits: "Proposed saving bookings to the backup store to restore booking.", doesNotFit: "Proposed saving bookings to the backup store, but the facts don't point to the booking store." },
    readAs: (value) => `The backup booking store reads as ${value ? "on" : "off"}.`,
    unreadable: "The backup booking store could not be read",
    sourceRef: "GET /backup-store",
    restored: "new bookings go to the backup store",
    leftover: "The main booking store is still down.",
    handoff: "Service is restored, not repaired: new bookings go to the backup store and the main store is still down.",
  },
};

/** The switch a catalog entry sets, when it is one turtl knows; otherwise null. */
export function switchOf(entry: Pick<Doc<"actionCatalog">, "type" | "config" | "parameterConstraints">): KnownSwitch | null {
  if (entry.type !== "set_feature_flag" || entry.config.kind !== "http") return null;
  const names = entry.parameterConstraints.find((constraint) => constraint.name === "flag")?.allowedValues ?? [];
  const known = names.find((name): name is string => typeof name === "string" && Object.keys(SWITCHES).includes(name));
  return known ? SWITCHES[known] : null;
}

/** The switch an approved payload sets: its "flag" parameter, when turtl knows it. */
export function switchNamed(flag: unknown): KnownSwitch | null {
  return typeof flag === "string" && Object.keys(SWITCHES).includes(flag) ? SWITCHES[flag] : null;
}
