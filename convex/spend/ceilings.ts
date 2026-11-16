import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import {
  ceilingRefusal,
  confirmedSignUpsPerDay,
  confirmedSignUpsPerHour,
  dayKey,
  deploymentModelSpendPerDayUsd,
  hourKey,
  newAccountsPerDay,
  newAccountsPerHour,
  passwordSignUpsPerDay,
  passwordSignUpsPerHour,
} from "./limits";

// Deployment-wide ceilings (review finding 7). Every other limit is per account or per project, so without these the
// operator's exposure is each limit times the number of accounts. They apply with accounts on only; the single-owner
// demo has none.

type Name = "accounts_hour" | "accounts_day" | "model_usd_day" | "password_signups_hour" | "password_signups_day" | "confirmations_hour" | "confirmations_day";
type Reader = Pick<QueryCtx, "db">;

/** Older windows of one total deleted at most when a new window starts; only the current one is read. */
const PRUNE = 10;

const row = (ctx: Reader, name: Name, window: string) =>
  ctx.db.query("deploymentTotals").withIndex("by_name_and_window", (q) => q.eq("name", name).eq("window", window)).unique();

async function total(ctx: Reader, name: Name, window: string): Promise<number> {
  return (await row(ctx, name, window))?.value ?? 0;
}

async function add(ctx: MutationCtx, name: Name, window: string, amount: number) {
  const now = Date.now();
  const current = await row(ctx, name, window);
  if (current) {
    await ctx.db.patch(current._id, { value: current.value + amount, updatedAt: now });
    return;
  }
  for (const old of await ctx.db.query("deploymentTotals").withIndex("by_name_and_window", (q) => q.eq("name", name).lt("window", window)).take(PRUNE)) {
    await ctx.db.delete(old._id);
  }
  await ctx.db.insert("deploymentTotals", { name, window, value: amount, updatedAt: now });
}

/** Every account's estimated model spend today (UTC). */
export async function deploymentSpendToday(ctx: Reader, at: number): Promise<number> {
  return await total(ctx, "model_usd_day", dayKey(at));
}

/** Whether the deployment's daily model ceiling is reached, for the gate (convex/consent/gate.ts). */
export async function deploymentSpendReached(ctx: Reader, at: number): Promise<boolean> {
  return (await deploymentSpendToday(ctx, at)) >= deploymentModelSpendPerDayUsd();
}

/** Adds a model call's estimated cost to today's deployment-wide total. Only the spend ledger calls this. */
export async function addDeploymentSpend(ctx: MutationCtx, costUsd: number) {
  await add(ctx, "model_usd_day", dayKey(Date.now()), costUsd);
}

/**
 * The three ways an account comes in, each with its own hourly and daily ceiling (finding 12), so filling one never
 * shuts another:
 * - "provider": a sign-up with Apple or GitHub, which cost a real Apple ID or GitHub account each.
 * - "password": a password sign-up, before its address is confirmed. Such an account reaches nothing, so a script of
 *   throwaway sign-ups fills only this one and holds up only other password sign-ups.
 * - "confirmation": a password account confirming its address, which is when it may start to act and spend.
 */
export type Admission = "provider" | "password" | "confirmation";

const CEILINGS: Record<Admission, { hour: Name; day: Name; perHour: () => number; perDay: () => number; thisHour: string; today: string }> = {
  provider: { hour: "accounts_hour", day: "accounts_day", perHour: newAccountsPerHour, perDay: newAccountsPerDay, thisHour: ceilingRefusal.accountsThisHour, today: ceilingRefusal.accountsToday },
  password: {
    hour: "password_signups_hour",
    day: "password_signups_day",
    perHour: passwordSignUpsPerHour,
    perDay: passwordSignUpsPerDay,
    thisHour: ceilingRefusal.passwordSignUpsThisHour,
    today: ceilingRefusal.passwordSignUpsToday,
  },
  confirmation: {
    hour: "confirmations_hour",
    day: "confirmations_day",
    perHour: confirmedSignUpsPerHour,
    perDay: confirmedSignUpsPerDay,
    thisHour: ceilingRefusal.confirmationsThisHour,
    today: ceilingRefusal.confirmationsToday,
  },
};

/**
 * Called inside the mutation that creates a user (Convex Auth's callback in convex/auth.ts) or confirms its address
 * (convex/auth/confirmation.ts), so the count and the change are one transaction. Refuses in plain words, which the app
 * shows as they are, once this hour's or today's count of that kind reaches its ceiling; the refusal undoes the change.
 */
export async function admitNewAccount(ctx: MutationCtx, kind: Admission): Promise<void> {
  if (!accessEnforced()) return;
  const now = Date.now();
  const ceiling = CEILINGS[kind];
  if ((await total(ctx, ceiling.hour, hourKey(now))) >= ceiling.perHour()) throw new ConvexError(ceiling.thisHour);
  if ((await total(ctx, ceiling.day, dayKey(now))) >= ceiling.perDay()) throw new ConvexError(ceiling.today);
  await add(ctx, ceiling.hour, hourKey(now), 1);
  await add(ctx, ceiling.day, dayKey(now), 1);
}
