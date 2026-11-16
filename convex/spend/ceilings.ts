import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { ceilingRefusal, dayKey, deploymentModelSpendPerDayUsd, hourKey, newAccountsPerDay, newAccountsPerHour } from "./limits";

// Deployment-wide ceilings (review finding 7). Every other limit is per account or per project, and nothing limits
// how many accounts a script makes (there is no email check yet), so without these the operator's exposure is each
// limit times the number of accounts. They apply with accounts on only; the single-owner demo has none.

type Name = "accounts_hour" | "accounts_day" | "model_usd_day";
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
 * Called by Convex Auth inside the mutation that creates a user (convex/auth.ts), so the count and the user are one
 * transaction. Refuses in plain words, which the app shows as they are, once this hour's or today's new accounts reach
 * their ceiling; the refusal undoes the user it was about to make.
 */
export async function admitNewAccount(ctx: MutationCtx): Promise<void> {
  if (!accessEnforced()) return;
  const now = Date.now();
  if ((await total(ctx, "accounts_hour", hourKey(now))) >= newAccountsPerHour()) throw new ConvexError(ceilingRefusal.accountsThisHour);
  if ((await total(ctx, "accounts_day", dayKey(now))) >= newAccountsPerDay()) throw new ConvexError(ceilingRefusal.accountsToday);
  await add(ctx, "accounts_hour", hourKey(now), 1);
  await add(ctx, "accounts_day", dayKey(now), 1);
}
