import { action, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { catalog } from "./catalog";
import { recommend } from "./provider";
import { completeBooking } from "./journeyCore";

export const getCatalog = query({ args: {}, handler: () => catalog() });

export const getFlags = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("bookingDemoSettings").withIndex("by_key", (q) => q.eq("key", "demo")).unique();
    return { recommendationsEnabled: row?.recommendationsEnabled ?? true };
  },
});

export const recommendations = action({
  args: {},
  handler: async (ctx): Promise<{ status: "disabled" | "ready" | "unavailable"; serviceIds: string[] }> => {
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
  handler: (ctx, args) => completeBooking(ctx, args),
});
