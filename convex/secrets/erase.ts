import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// Erasers for deleting a project or an account (convex/account/). Each removes up to BATCH rows and says whether more
// remain, so a caller runs it again until `more` is false.

const BATCH = 100;

// Every secret stored for one project: its control token.
export const forProject = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.object({ removed: v.number(), more: v.boolean() }),
  handler: async (ctx, { appId }) => {
    const rows = await ctx.db.query("secrets").withIndex("by_app_and_kind", (q) => q.eq("appId", appId)).take(BATCH + 1);
    for (const row of rows.slice(0, BATCH)) await ctx.db.delete(row._id);
    return { removed: Math.min(rows.length, BATCH), more: rows.length > BATCH };
  },
});

// Every secret an account set: its coding agent key, and the control tokens of the projects it owned.
export const forAccount = internalMutation({
  args: { account: v.string() },
  returns: v.object({ removed: v.number(), more: v.boolean() }),
  handler: async (ctx, { account }) => {
    const rows = await ctx.db.query("secrets").withIndex("by_account_and_kind", (q) => q.eq("account", account)).take(BATCH + 1);
    for (const row of rows.slice(0, BATCH)) await ctx.db.delete(row._id);
    return { removed: Math.min(rows.length, BATCH), more: rows.length > BATCH };
  },
});
