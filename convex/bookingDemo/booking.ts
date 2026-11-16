import { action, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { requireBookingDemo } from "../access";
import { catalog } from "./catalog";
import { recommend } from "./provider";
import { completeBooking } from "./journeyCore";

// The booking demo's own API for its customers, not turtl's: no sign-in, by design. A deployment with accounts on
// serves it only when it hosts the booking demo (convex/access.ts, hostsBookingDemo), so production never does.

export const getCatalog = query({
  args: {},
  handler: () => {
    requireBookingDemo();
    return catalog();
  },
});

export const getFlags = query({
  args: {},
  handler: async (ctx) => {
    requireBookingDemo();
    const row = await ctx.db.query("bookingDemoSettings").withIndex("by_key", (q) => q.eq("key", "demo")).unique();
    return { recommendationsEnabled: row?.recommendationsEnabled ?? true };
  },
});

export const recommendations = action({
  args: {},
  handler: async (ctx): Promise<{ status: "disabled" | "ready" | "unavailable"; serviceIds: string[] }> => {
    requireBookingDemo();
    const state = await ctx.runQuery(internal.bookingDemo.state.read, {});
    if (!state.recommendationsEnabled) return { status: "disabled" as const, serviceIds: [] };
    try {
      return { status: "ready" as const, serviceIds: await recommend(state.providerTimeout) };
    } catch {
      return { status: "unavailable" as const, serviceIds: [] };
    }
  },
});

export const submit = action({
  args: { serviceId: v.string(), date: v.string(), time: v.string() },
  handler: (ctx, args) => {
    requireBookingDemo();
    return completeBooking(ctx, args);
  },
});
