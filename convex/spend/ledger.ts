import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { addDeploymentSpend } from "./ceilings";
import { codingThreadsPerDay, dayKey, intakeCasesPerDay, MODEL_CALL_HOLD_MS, monthKey } from "./limits";

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

/** Adds to the account's totals for today, starting the day's row (and dropping older ones) if needed. Given an
 * earlier day (a hold counted then), it changes that day's row if it is still kept, and nothing otherwise. */
async function addToAccountDay(ctx: MutationCtx, account: string, add: AccountDayAdd, on?: string) {
  const now = Date.now();
  const day = on ?? dayKey(now);
  const row = await accountDayRow(ctx, account, day);
  if (!row && day !== dayKey(now)) return;
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

/** Where each share's spend and holds are kept on the account's day. */
const SPENT: Record<Share, "ownUsd" | "intakeUsd" | "practiceUsd" | "floorUsd"> = { own: "ownUsd", intake: "intakeUsd", practice: "practiceUsd", floor: "floorUsd" };
const HELD: Record<Share, "ownHeldUsd" | "intakeHeldUsd" | "practiceHeldUsd" | "floorHeldUsd"> = {
  own: "ownHeldUsd",
  intake: "intakeHeldUsd",
  practice: "practiceHeldUsd",
  floor: "floorHeldUsd",
};

/** Counts a model call the gate just let through at its hold until its cost comes back (addModelSpend): against the
 * account's share it spends, against the shared day or the floor, and against the deployment's hard stop. Returns the
 * hold's own row, which its cost, an error status from the vendor, or MODEL_CALL_HOLD_MS settles. */
export async function holdModelCall(ctx: MutationCtx, account: string, share: Share, holdUsd: number, appId?: Id<"apps">): Promise<Id<"modelCallHolds">> {
  const now = Date.now();
  await addToAccountDay(ctx, account, { [HELD[share]]: holdUsd });
  await addToDeploymentDay(ctx, { heldUsd: holdUsd, ...(share === "floor" && { floorHeldUsd: holdUsd }) });
  return await ctx.db.insert("modelCallHolds", {
    account,
    day: dayKey(now),
    share,
    ...(appId && { appId }),
    heldUsd: holdUsd,
    expiresAt: now + MODEL_CALL_HOLD_MS,
  });
}

export type DeploymentDay = { floorUsd: number; heldUsd: number; floorHeldUsd: number; stopLoggedAt: number | null };

const deploymentDayRow = (ctx: Reader, day: string) =>
  ctx.db.query("deploymentModelDays").withIndex("by_day", (q) => q.eq("day", day)).unique();

/** What every account's floor cost today (UTC), what every call still out is held at (and how much of that on floors),
 * and when the log was told the hard stop was reached. With the shared day's cost (deploymentSpendToday) it is
 * everything the hard stop counts. */
export async function deploymentDay(ctx: Reader, at: number): Promise<DeploymentDay> {
  const row = await deploymentDayRow(ctx, dayKey(at));
  return { floorUsd: row?.floorUsd ?? 0, heldUsd: row?.heldUsd ?? 0, floorHeldUsd: row?.floorHeldUsd ?? 0, stopLoggedAt: row?.stopLoggedAt ?? null };
}

/** Adds to the deployment's totals for today, starting the day's row (and dropping older ones) if needed. Given an
 * earlier day (a hold counted then), it changes that day's row if it is still kept, and nothing otherwise. */
async function addToDeploymentDay(ctx: MutationCtx, add: { floorUsd?: number; heldUsd?: number; floorHeldUsd?: number; stopLoggedAt?: number }, on?: string) {
  const now = Date.now();
  const day = on ?? dayKey(now);
  const row = await deploymentDayRow(ctx, day);
  if (!row && day !== dayKey(now)) return;
  const fields = {
    floorUsd: cents((row?.floorUsd ?? 0) + (add.floorUsd ?? 0)),
    heldUsd: cents((row?.heldUsd ?? 0) + (add.heldUsd ?? 0)),
    floorHeldUsd: cents((row?.floorHeldUsd ?? 0) + (add.floorHeldUsd ?? 0)),
    ...(add.stopLoggedAt !== undefined && { stopLoggedAt: add.stopLoggedAt }),
    updatedAt: now,
  };
  if (row) {
    await ctx.db.patch(row._id, fields);
    return;
  }
  for (const old of await ctx.db.query("deploymentModelDays").withIndex("by_day", (q) => q.lt("day", day)).take(PRUNE_DAYS)) {
    await ctx.db.delete(old._id);
  }
  await ctx.db.insert("deploymentModelDays", { day, ...fields });
}

/** Records that the backend log was told today's hard stop was reached, so it is told once a day. */
export async function noteHardStop(ctx: MutationCtx) {
  await addToDeploymentDay(ctx, { stopLoggedAt: Date.now() });
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

type Settlement = {
  account: string;
  share: Share;
  appId?: Id<"apps">;
  /** What the call cost: its reported cost, its hold when its cost never came back, or nothing for an error status. */
  costUsd: number;
  /** The hold it was let through with, released on the day it was counted. */
  releaseUsd: number;
  releaseDay: string;
  /** Whether to count it on the account's day and month too: "no" for an account being deleted, "if known" for the
   * sweep, which may find a hold whose account is gone. */
  onAccount?: "yes" | "no" | "if known";
};

/**
 * Puts a call's cost in place of its hold: on the account's day (the share it was held on) and month, the project's
 * customer-report day, the shared day or the floor, and the deployment's hard stop. A cost counts today; the hold is
 * released on the day it was counted, so a hold that ran past midnight takes nothing off today's holds. An account that
 * is gone (being deleted) has no day or month to count on: its calls count in the deployment's totals only.
 */
async function settle(ctx: MutationCtx, { account, share, appId, costUsd, releaseUsd, releaseDay, onAccount = "yes" }: Settlement) {
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const release = Number.isFinite(releaseUsd) && releaseUsd > 0 ? releaseUsd : 0;
  if (cost === 0 && release === 0) return;
  const today = dayKey(Date.now());
  const user = onAccount === "if known" ? ctx.db.normalizeId("users", account) : null;
  const known = onAccount === "yes" || (user !== null && (await ctx.db.get(user)) !== null);
  if (known) {
    const spent = cost > 0 ? { [SPENT[share]]: cost, calls: 1 } : {};
    if (releaseDay === today) await addToAccountDay(ctx, account, { ...spent, [HELD[share]]: -release });
    else {
      if (release > 0) await addToAccountDay(ctx, account, { [HELD[share]]: -release }, releaseDay);
      if (cost > 0) await addToAccountDay(ctx, account, spent);
    }
  }
  const floor = share === "floor";
  const held = { heldUsd: -release, ...(floor && { floorHeldUsd: -release }) };
  if (releaseDay === today) await addToDeploymentDay(ctx, { ...held, ...(floor && { floorUsd: cost }) });
  else {
    if (release > 0) await addToDeploymentDay(ctx, held, releaseDay);
    if (floor && cost > 0) await addToDeploymentDay(ctx, { floorUsd: cost });
  }
  if (cost === 0) return;
  // Every call counts toward the deployment's shared day too, whichever allowance it spent, except one on a floor.
  if (!floor) await addDeploymentSpend(ctx, cost);
  if (share === "intake") {
    if (appId && (await ctx.db.get(appId))) await addToIntakeDay(ctx, appId, { costUsd: cost, calls: 1, casesOpened: 0 });
    return;
  }
  if (!known) return;
  const now = Date.now();
  const month = monthKey(now);
  const row = await ctx.db
    .query("modelSpend")
    .withIndex("by_account_and_month", (q) => q.eq("account", account).eq("month", month))
    .unique();
  if (row) await ctx.db.patch(row._id, { costUsd: row.costUsd + cost, calls: row.calls + 1, updatedAt: now });
  else await ctx.db.insert("modelSpend", { account, month, costUsd: cost, calls: 1, updatedAt: now });
}

// A call's cost, in place of the hold the gate let it through with (`holdId`; finding 26). The hold's own row says
// whose it is and which share it was held on: with appId the call read a project's customer reports and counts against
// that project's day and the account's customer-report share; a practice app's call against the practice allowance
// (within the account's own share) and the month; a floor's against the account's floor and month and not the shared
// day; any other against the account's own share and month. A hold already settled (its time ran out and it was
// counted at its hold, or its account was deleted) takes nothing more. Without holdId (a call let through before holds
// had rows), `held` and the flags say the same.
export const addModelSpend = internalMutation({
  args: {
    account: v.string(),
    costUsd: v.number(),
    holdId: v.optional(v.id("modelCallHolds")),
    appId: v.optional(v.id("apps")),
    held: v.optional(v.number()),
    practice: v.optional(v.boolean()),
    floor: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { account, costUsd, holdId, appId, held, practice, floor }) => {
    if (holdId) {
      const hold = await ctx.db.get(holdId);
      if (!hold) return null;
      await ctx.db.delete(hold._id);
      await settle(ctx, { account: hold.account, share: hold.share, appId: hold.appId, costUsd, releaseUsd: hold.heldUsd, releaseDay: hold.day });
      return null;
    }
    const share: Share = appId ? "intake" : floor ? "floor" : practice ? "practice" : "own";
    await settle(ctx, { account, share, appId, costUsd, releaseUsd: held ?? 0, releaseDay: dayKey(Date.now()) });
    return null;
  },
});

/** Holds settled per run of the sweep; a full batch runs the sweep again at once. */
const SETTLE_BATCH = 100;

// Every minute (convex/crons.ts): each hold still standing MODEL_CALL_HOLD_MS after its call was let through is counted
// at its own amount (finding 26). No action outlives that, so its cost can no longer come back: the call timed out,
// failed after the vendor may have done the work, or its action stopped before or after sending it. The hold is the
// most the call could cost, so counting it so never lets a call that cost something go free. One line in the backend
// log says how many and how much, so the operator sees calls whose cost was not reported.
export const settleExpiredHolds = internalMutation({
  args: {},
  returns: v.object({ settled: v.number(), usd: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db.query("modelCallHolds").withIndex("by_expires", (q) => q.lte("expiresAt", now)).take(SETTLE_BATCH);
    let usd = 0;
    for (const hold of due) {
      await ctx.db.delete(hold._id);
      await settle(ctx, { account: hold.account, share: hold.share, appId: hold.appId, costUsd: hold.heldUsd, releaseUsd: hold.heldUsd, releaseDay: hold.day, onAccount: "if known" });
      usd += hold.heldUsd;
    }
    if (due.length) {
      console.warn(`${due.length} model call${due.length === 1 ? "" : "s"} reported no cost within ${MODEL_CALL_HOLD_MS / 60_000} minutes and ${due.length === 1 ? "was" : "were"} counted at ${due.length === 1 ? "its hold" : "their holds"}, $${usd.toFixed(2)} in all.`);
    }
    if (due.length === SETTLE_BATCH) await ctx.scheduler.runAfter(0, internal.spend.ledger.settleExpiredHolds, {});
    return { settled: due.length, usd };
  },
});

// Account deletion (convex/account/registry.ts): the account's calls still out are counted at their holds in the
// deployment's totals, so deleting an account mid-call neither frees what its calls may have cost nor leaves its holds
// standing in the deployment's day. A bounded batch per run.
export const eraseHolds = internalMutation({
  args: { account: v.string() },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, { account }) => {
    const batch = await ctx.db.query("modelCallHolds").withIndex("by_account_and_expires", (q) => q.eq("account", account)).take(SETTLE_BATCH);
    for (const hold of batch) {
      await ctx.db.delete(hold._id);
      await settle(ctx, { account: hold.account, share: hold.share, appId: hold.appId, costUsd: hold.heldUsd, releaseUsd: hold.heldUsd, releaseDay: hold.day, onAccount: "no" });
    }
    return { done: batch.length < SETTLE_BATCH };
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
