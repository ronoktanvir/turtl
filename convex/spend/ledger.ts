import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { codingThreadsPerDay, dayKey, intakeCasesPerDay, monthKey } from "./limits";

// Writes and reads of the running totals. Only the gate (convex/consent/gate.ts) writes spend here, after a call it
// let through; intake (convex/intake/records.ts) counts the cases customer reports open.

type Reader = Pick<QueryCtx, "db">;

/** Older days of a project's customer-report totals deleted at most per new day; the check needs only today's. */
const PRUNE_DAYS = 10;

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

const intakeDay = (ctx: Reader, appId: Id<"apps">, day: string) =>
  ctx.db.query("intakeDays").withIndex("by_app_and_day", (q) => q.eq("appId", appId).eq("day", day)).unique();

/** Estimated model spend on the project's customer reports today (UTC), apart from the account's month. */
export async function intakeSpendToday(ctx: Reader, appId: Id<"apps">, at: number): Promise<number> {
  return (await intakeDay(ctx, appId, dayKey(at)))?.costUsd ?? 0;
}

/** Adds to the project's customer-report totals for today, starting the day's row (and dropping older ones) if needed. */
async function addToIntakeDay(ctx: MutationCtx, appId: Id<"apps">, add: { costUsd: number; calls: number; casesOpened: number }) {
  const now = Date.now();
  const day = dayKey(now);
  const row = await intakeDay(ctx, appId, day);
  if (row) {
    await ctx.db.patch(row._id, { costUsd: row.costUsd + add.costUsd, calls: row.calls + add.calls, casesOpened: row.casesOpened + add.casesOpened, updatedAt: now });
    return;
  }
  for (const old of await ctx.db.query("intakeDays").withIndex("by_app_and_day", (q) => q.eq("appId", appId).lt("day", day)).take(PRUNE_DAYS)) {
    await ctx.db.delete(old._id);
  }
  await ctx.db.insert("intakeDays", { appId, day, ...add, updatedAt: now });
}

/** Counts a case opened from customer reports today, or says no when the project's daily cap is reached. */
export async function openIntakeCase(ctx: MutationCtx, appId: Id<"apps">): Promise<boolean> {
  const opened = (await intakeDay(ctx, appId, dayKey(Date.now())))?.casesOpened ?? 0;
  if (opened >= intakeCasesPerDay()) return false;
  await addToIntakeDay(ctx, appId, { costUsd: 0, calls: 0, casesOpened: 1 });
  return true;
}

// With appId the call read a project's customer reports and counts against that project's day (the intake
// allowance); without it, against the account's month.
export const addModelSpend = internalMutation({
  args: { account: v.string(), costUsd: v.number(), appId: v.optional(v.id("apps")) },
  returns: v.null(),
  handler: async (ctx, { account, costUsd, appId }) => {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
    if (appId) {
      await addToIntakeDay(ctx, appId, { costUsd, calls: 1, casesOpened: 0 });
      return null;
    }
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
