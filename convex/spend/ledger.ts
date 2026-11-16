import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { addDeploymentSpend } from "./ceilings";
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

export type AccountDay = {
  ownUsd: number;
  ownHeldUsd: number;
  intakeUsd: number;
  intakeHeldUsd: number;
  practiceUsd: number;
  practiceHeldUsd: number;
  floorUsd: number;
  floorHeldUsd: number;
};
type AccountDayAdd = Partial<AccountDay> & { calls?: number };

const accountDayRow = (ctx: Reader, account: string, day: string) =>
  ctx.db.query("accountSpendDays").withIndex("by_account_and_day", (q) => q.eq("account", account).eq("day", day)).unique();

/** What the account's own calls, its practice app and its projects' customer reports cost today (UTC), and what is held. */
export async function accountDay(ctx: Reader, account: string, at: number): Promise<AccountDay> {
  const row = await accountDayRow(ctx, account, dayKey(at));
  return {
    ownUsd: row?.ownUsd ?? 0,
    ownHeldUsd: row?.ownHeldUsd ?? 0,
    intakeUsd: row?.intakeUsd ?? 0,
    intakeHeldUsd: row?.intakeHeldUsd ?? 0,
    practiceUsd: row?.practiceUsd ?? 0,
    practiceHeldUsd: row?.practiceHeldUsd ?? 0,
    floorUsd: row?.floorUsd ?? 0,
    floorHeldUsd: row?.floorHeldUsd ?? 0,
  };
}

const cents = (value: number) => Math.max(0, Math.round(value * 1e6) / 1e6);

/** Adds to the account's totals for today, starting the day's row (and dropping older ones) if needed. */
async function addToAccountDay(ctx: MutationCtx, account: string, add: AccountDayAdd) {
  const now = Date.now();
  const day = dayKey(now);
  const row = await accountDayRow(ctx, account, day);
  const next = (field: keyof AccountDay) => cents((row?.[field] ?? 0) + (add[field] ?? 0));
  const fields = {
    ownUsd: next("ownUsd"),
    ownHeldUsd: next("ownHeldUsd"),
    intakeUsd: next("intakeUsd"),
    intakeHeldUsd: next("intakeHeldUsd"),
    practiceUsd: next("practiceUsd"),
    practiceHeldUsd: next("practiceHeldUsd"),
    floorUsd: next("floorUsd"),
    floorHeldUsd: next("floorHeldUsd"),
    calls: (row?.calls ?? 0) + (add.calls ?? 0),
    updatedAt: now,
  };
  if (row) {
    await ctx.db.patch(row._id, fields);
    return;
  }
  for (const old of await ctx.db.query("accountSpendDays").withIndex("by_account_and_day", (q) => q.eq("account", account).lt("day", day)).take(PRUNE_DAYS)) {
    await ctx.db.delete(old._id);
  }
  await ctx.db.insert("accountSpendDays", { account, day, ...fields });
}

/** Counts a model call the gate just let through at MODEL_CALL_HOLD_USD until its cost comes back (addModelSpend). */
export async function holdModelCall(ctx: MutationCtx, account: string, share: Share, holdUsd: number) {
  const held: Record<Share, Partial<AccountDay>> = {
    own: { ownHeldUsd: holdUsd },
    intake: { intakeHeldUsd: holdUsd },
    practice: { practiceHeldUsd: holdUsd },
    floor: { floorHeldUsd: holdUsd },
  };
  await addToAccountDay(ctx, account, held[share]);
}

/** Which of the account's day shares a model call counts against. */
export type Share = "own" | "intake" | "practice" | "floor";

/** Counts a case opened from customer reports today, or says no when the project's daily cap is reached. */
export async function openIntakeCase(ctx: MutationCtx, appId: Id<"apps">): Promise<boolean> {
  const opened = (await intakeDay(ctx, appId, dayKey(Date.now())))?.casesOpened ?? 0;
  if (opened >= intakeCasesPerDay()) return false;
  await addToIntakeDay(ctx, appId, { costUsd: 0, calls: 0, casesOpened: 1 });
  return true;
}

// With appId the call read a project's customer reports and counts against that project's day (the intake
// allowance); without it, against the account's month. Either way it counts against the account's day, in place of
// the hold (`held`) the gate counted it at when it let the call through.
// `practice`: the call was for the account's practice app: it counts against the day's practice allowance instead of
// the account's own share, and against the month as an own call does.
// `floor`: the call found the cause of the account's own outage past the shared day: it counts against the account's
// floor and its month, and not against the deployment's day, which it is outside of.
export const addModelSpend = internalMutation({
  args: {
    account: v.string(),
    costUsd: v.number(),
    appId: v.optional(v.id("apps")),
    held: v.optional(v.number()),
    practice: v.optional(v.boolean()),
    floor: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { account, costUsd, appId, held, practice, floor }) => {
    const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    const release = held !== undefined && Number.isFinite(held) && held > 0 ? held : 0;
    if (cost > 0 || release > 0) {
      const calls = cost > 0 ? 1 : 0;
      await addToAccountDay(
        ctx,
        account,
        appId
          ? { intakeUsd: cost, intakeHeldUsd: -release, calls }
          : floor
            ? { floorUsd: cost, floorHeldUsd: -release, calls }
            : practice
              ? { practiceUsd: cost, practiceHeldUsd: -release, calls }
              : { ownUsd: cost, ownHeldUsd: -release, calls },
      );
    }
    if (cost === 0) return null;
    costUsd = cost;
    // Every call counts toward the deployment's day too, whichever allowance it spent, except one on the floor.
    if (!floor) await addDeploymentSpend(ctx, costUsd);
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
