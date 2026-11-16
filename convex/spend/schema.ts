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
};
