import { defineTable } from "convex/server";
import { v } from "convex/values";

/** The failures an owner can give their practice app on purpose: the two the booking demo already knows. */
export const vPracticeFailure = v.union(v.literal("recommendations"), v.literal("booking_store"));
export type PracticeFailure = "recommendations" | "booking_store";

export const practiceTables = {
  // One practice app per practice project (convex/practice): the switches that decide whether its booking journey works,
  // the SHA-256 of the project's own control token (its routes answer only to that token; the token itself is sealed in
  // convex/secrets like any project's), and how often its owner has broken it today. Deleted with the project.
  practiceApps: defineTable({
    appId: v.id("apps"),
    ownerId: v.string(),
    tokenHash: v.string(),
    recommendationsEnabled: v.boolean(),
    providerTimeout: v.boolean(),
    bookingStoreFailure: v.boolean(),
    backupStoreEnabled: v.boolean(),
    updatedAt: v.number(),
    /** The failure the owner last chose, and when. */
    broken: v.optional(v.object({ failure: vPracticeFailure, at: v.number() })),
    /** Breaks the owner made on one UTC day, for the daily limit. */
    breaks: v.optional(v.object({ day: v.string(), count: v.number() })),
  })
    .index("by_app", ["appId"])
    .index("by_owner", ["ownerId"]),
  // The test bookings a practice app's journey check makes, each deleted by the same check. A row outlives its check only
  // if the cleanup failed, and goes with the project.
  practiceBookings: defineTable({
    appId: v.id("apps"),
    fixtureRunId: v.string(),
    serviceId: v.string(),
    date: v.string(),
    time: v.string(),
    store: v.union(v.literal("main"), v.literal("backup")),
    createdAt: v.number(),
  }).index("by_app_and_fixture", ["appId", "fixtureRunId"]),
};
