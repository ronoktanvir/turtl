import { internalMutation, internalQuery } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { bookingError } from "./validators";
import { revision } from "./catalog";

export const saveBooking = internalMutation({
  args: { serviceId: v.string(), date: v.string(), time: v.string(), fixtureRunId: v.optional(v.string()), bookingStoreFailure: v.boolean() },
  handler: async (ctx, args) => {
    const { bookingStoreFailure, ...booking } = args;
    // STAGED FAILURE: the booking write is unavailable, independently of recommendations.
    if (bookingStoreFailure) throw new ConvexError({ code: "BOOKING_STORE_UNAVAILABLE" });
    const bookingId = await ctx.db.insert("bookingDemoBookings", { ...booking, createdAt: Date.now() });
    if (!args.fixtureRunId) {
      await ctx.db.insert("bookingDemoAttempts", {
        serviceId: args.serviceId, date: args.date, time: args.time,
        timestamp: Date.now(), status: "passed", revision: revision(),
      });
    }
    return bookingId;
  },
});

export const saveFailure = internalMutation({
  args: { serviceId: v.string(), date: v.string(), time: v.string(), error: bookingError },
  handler: (ctx, args) => ctx.db.insert("bookingDemoAttempts", {
    ...args, timestamp: Date.now(), status: "failed", revision: revision(),
  }),
});

export const readBooking = internalQuery({
  args: { bookingId: v.id("bookingDemoBookings") },
  handler: (ctx, args) => ctx.db.get(args.bookingId),
});

export const cleanup = internalMutation({
  args: { fixtureRunId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("bookingDemoBookings").withIndex("by_fixture", (q) => q.eq("fixtureRunId", args.fixtureRunId)).collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

export const impact = internalQuery({
  args: { since: v.number(), until: v.number() },
  handler: async (ctx, args) => {
    const attempts = await ctx.db.query("bookingDemoAttempts").withIndex("by_timestamp", (q) => q.gte("timestamp", args.since).lte("timestamp", args.until)).order("desc").take(1001);
    const sample = attempts.slice(0, 1000);
    const failures = sample.filter((a) => a.status === "failed");
    return {
      window: { since: args.since, until: args.until, sampleLimit: 1000, truncated: attempts.length > 1000 },
      counts: { totalBookings: sample.length, failedBookings: failures.length, successfulBookings: sample.length - failures.length, errorRate: sample.length ? failures.length / sample.length : 0 },
      errors: failures.slice(0, 20).map((a) => ({ id: a._id, timestamp: a.timestamp, revision: a.revision, serviceId: a.serviceId, date: a.date, time: a.time, ...a.error! })),
    };
  },
});
