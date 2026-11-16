import { defineTable } from "convex/server";
import { v } from "convex/values";

// Running totals per account. The model calls themselves are logged elsewhere (agentRuns, voiceRuns); these rows only
// hold what the limits need, so the check before each call reads one row.
export const spendTables = {
  // One row per account per calendar month (UTC): the estimated model spend so far and how many calls made it.
  modelSpend: defineTable({
    account: v.string(),
    month: v.string(),
    costUsd: v.number(),
    calls: v.number(),
    updatedAt: v.number(),
  }).index("by_account_and_month", ["account", "month"]),
  // One row per coding-agent thread an account started, by calendar day (UTC). The request id makes a retried start
  // count once.
  codingThreads: defineTable({
    account: v.string(),
    day: v.string(),
    requestId: v.string(),
    startedAt: v.number(),
  }).index("by_account_day_and_request", ["account", "day", "requestId"]),
  // One row per project per calendar day (UTC) on which its customer reports cost something: the estimated model spend
  // of reading them (triage, and the cases they opened) and how many cases they opened. Kept apart from the account's
  // month, so a customer cannot spend what diagnosing the owner's outages needs. Older days are deleted as new ones
  // start; the rows go with the project.
  intakeDays: defineTable({
    appId: v.id("apps"),
    day: v.string(),
    costUsd: v.number(),
    calls: v.number(),
    casesOpened: v.number(),
    updatedAt: v.number(),
  }).index("by_app_and_day", ["appId", "day"]),
  // Deployment-wide running totals that belong to no account (finding 7): new accounts per clock hour and per day (Apple
  // and GitHub sign-ups, password sign-ups, and password accounts confirming their address, each counted apart), and
  // every account's model spend per day. `window` is the hour ("2026-11-15T12") or the day ("2026-11-15"), UTC. Older
  // windows of a name are deleted as a new one starts. Not deleted with an account: the totals count everyone.
  deploymentTotals: defineTable({
    name: v.union(
      v.literal("accounts_hour"),
      v.literal("accounts_day"),
      v.literal("model_usd_day"),
      v.literal("password_signups_hour"),
      v.literal("password_signups_day"),
      v.literal("confirmations_hour"),
      v.literal("confirmations_day"),
    ),
    window: v.string(),
    value: v.number(),
    updatedAt: v.number(),
  }).index("by_name_and_window", ["name", "window"]),
};
