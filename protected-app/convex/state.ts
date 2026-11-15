import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const read = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "demo")).unique();
    return {
      recommendationsEnabled: row?.recommendationsEnabled ?? true,
      providerTimeout: row?.providerTimeout ?? false,
      updatedAt: row?.updatedAt ?? null,
    };
  },
});

export const set = internalMutation({
  args: { recommendationsEnabled: v.optional(v.boolean()), providerTimeout: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "demo")).unique();
    const next = {
      recommendationsEnabled: args.recommendationsEnabled ?? row?.recommendationsEnabled ?? true,
      providerTimeout: args.providerTimeout ?? row?.providerTimeout ?? false,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert("settings", { key: "demo", ...next });
    return next;
  },
});
