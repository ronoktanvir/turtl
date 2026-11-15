import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const bookingError = v.object({
  code: v.string(),
  message: v.string(),
  step: v.string(),
  provider: v.optional(v.string()),
  retryable: v.boolean(),
});

export default defineSchema({
  settings: defineTable({
    key: v.literal("demo"),
    recommendationsEnabled: v.boolean(),
    providerTimeout: v.boolean(),
    bookingStoreFailure: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  bookings: defineTable({
    serviceId: v.string(),
    date: v.string(),
    time: v.string(),
    createdAt: v.number(),
    fixtureRunId: v.optional(v.string()),
  }).index("by_fixture", ["fixtureRunId"]),
  bookingAttempts: defineTable({
    serviceId: v.string(),
    date: v.string(),
    time: v.string(),
    timestamp: v.number(),
    status: v.union(v.literal("passed"), v.literal("failed")),
    revision: v.string(),
    error: v.optional(bookingError),
  }).index("by_timestamp", ["timestamp"]),
});
