import { v } from "convex/values";
import { internalMutation, type QueryCtx } from "../_generated/server";
import { codingThreadsPerDay, dayKey, monthKey } from "./limits";

// Writes and reads of the running totals. Only the gate (convex/consent/gate.ts) writes here, after a call it let through.

type Reader = Pick<QueryCtx, "db">;

/** Estimated model spend for the account in this calendar month (UTC). */
export async function monthSpend(ctx: Reader, account: string, at: number): Promise<number> {
  const row = await ctx.db
    .query("modelSpend")
    .withIndex("by_account_and_month", (q) => q.eq("account", account).eq("month", monthKey(at)))
    .unique();
  return row?.costUsd ?? 0;
}

/** Coding-agent threads the account started today (UTC), read no further than the daily limit. */
export async function threadsToday(ctx: Reader, account: string, at: number): Promise<number> {
  const rows = await ctx.db
    .query("codingThreads")
    .withIndex("by_account_day_and_request", (q) => q.eq("account", account).eq("day", dayKey(at)))
    .take(codingThreadsPerDay());
  return rows.length;
}

export const addModelSpend = internalMutation({
  args: { account: v.string(), costUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, { account, costUsd }) => {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
    const now = Date.now();
    const month = monthKey(now);
    const row = await ctx.db
      .query("modelSpend")
      .withIndex("by_account_and_month", (q) => q.eq("account", account).eq("month", month))
      .unique();
    if (row) await ctx.db.patch(row._id, { costUsd: row.costUsd + costUsd, calls: row.calls + 1, updatedAt: now });
    else await ctx.db.insert("modelSpend", { account, month, costUsd, calls: 1, updatedAt: now });
    return null;
  },
});

export const recordThread = internalMutation({
  args: { account: v.string(), requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, { account, requestId }) => {
    const now = Date.now();
    const day = dayKey(now);
    const seen = await ctx.db
      .query("codingThreads")
      .withIndex("by_account_day_and_request", (q) => q.eq("account", account).eq("day", day).eq("requestId", requestId))
      .first();
    if (!seen) await ctx.db.insert("codingThreads", { account, day, requestId, startedAt: now });
    return null;
  },
});
