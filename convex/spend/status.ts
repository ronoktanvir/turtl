import { v } from "convex/values";
import { query } from "../functions";
import { accessEnforced, currentAccount } from "../access";
import { codingThreadsPerDay, monthKey, monthLabel, modelSpendLimitUsd } from "./limits";
import { monthSpend, threadsToday } from "./ledger";

// Where the signed-in account stands against its limits, for the line in the gear sheet. In the single-owner demo
// there is no limit, and `enforced` is false so the app shows nothing.
export const mine = query({
  args: {},
  returns: v.object({
    enforced: v.boolean(),
    signedIn: v.boolean(),
    month: v.string(),
    spentUsd: v.number(),
    limitUsd: v.number(),
    threadsToday: v.number(),
    threadsPerDay: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const enforced = accessEnforced();
    const account = await currentAccount(ctx);
    const base = { enforced, signedIn: account !== null, month: monthLabel(monthKey(now)), limitUsd: modelSpendLimitUsd(), threadsPerDay: codingThreadsPerDay() };
    if (!enforced || !account) return { ...base, spentUsd: 0, threadsToday: 0 };
    return { ...base, spentUsd: await monthSpend(ctx, account, now), threadsToday: await threadsToday(ctx, account, now) };
  },
});
