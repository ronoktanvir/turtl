import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { mutation, query } from "../functions";
import { accessEnforced, currentAccount, requireAccount } from "../access";
import { vPushPlatform } from "./schema";

// The phones that receive an account's push notifications. Every public function asks convex/access.ts who is
// calling, and a phone only ever acts on its own token under the caller's account.

/** More phones than one owner carries; the oldest is replaced when a new one would go past it. */
export const MAX_LIVE_TOKENS = 10;
/** Tokens Expo turned away are kept this many per account, so the record stays bounded. */
const MAX_DISABLED_TOKENS = 10;
const REMOVE_BATCH = 100;

export const INVALID_TOKEN = "This phone did not give a valid notification address. Try turning notifications on again.";
export const TOKEN_IN_USE =
  "This phone still gets notifications for another turtl account. Sign in to that account on this phone and sign out (or turn its notifications off), then try again.";

const TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
export const isPushToken = (token: string) => TOKEN.test(token);

function requireToken(token: string) {
  if (!isPushToken(token)) throw new ConvexError(INVALID_TOKEN);
}

const byToken = (ctx: Pick<QueryCtx, "db">, token: string) =>
  ctx.db.query("pushTokens").withIndex("by_token", (q) => q.eq("token", token)).unique();

async function makeRoom(ctx: MutationCtx, account: string, now: number) {
  const live = await ctx.db
    .query("pushTokens")
    .withIndex("by_account_and_disabled", (q) => q.eq("account", account).eq("disabledAt", undefined))
    .take(MAX_LIVE_TOKENS + 1);
  const oldest = [...live].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  for (const row of oldest.slice(0, Math.max(0, live.length - MAX_LIVE_TOKENS + 1))) {
    await ctx.db.patch(row._id, { disabledAt: now, disabledReason: "replaced" });
  }
  const disabled = await ctx.db
    .query("pushTokens")
    .withIndex("by_account_and_disabled", (q) => q.eq("account", account).gt("disabledAt", 0))
    .order("desc")
    .take(MAX_DISABLED_TOKENS + REMOVE_BATCH);
  for (const row of disabled.slice(MAX_DISABLED_TOKENS)) await ctx.db.delete(row._id);
}

/** The token's row, or a refusal when it is live on another account. */
async function refuseElsewhere(ctx: MutationCtx, account: string, token: string) {
  const row = await byToken(ctx, token);
  if (row && row.account !== account && row.disabledAt === undefined) throw new ConvexError(TOKEN_IN_USE);
  return row;
}

/** Files this token under the account as a live phone. A token that is live on another account is refused: anyone
 * who learned it could otherwise move that owner's notifications to themselves. Signing out frees it (remove), and a
 * token that account no longer uses (disabled) moves. */
async function keep(ctx: MutationCtx, account: string, token: string, platform: Doc<"pushTokens">["platform"]) {
  const now = Date.now();
  const row = await refuseElsewhere(ctx, account, token);
  const liveHere = row && row.account === account && row.disabledAt === undefined;
  if (!liveHere) await makeRoom(ctx, account, now);
  if (!row) {
    await ctx.db.insert("pushTokens", { account, token, platform, addedAt: now, lastSeenAt: now });
    return;
  }
  await ctx.db.patch(row._id, {
    account,
    platform,
    lastSeenAt: now,
    disabledAt: undefined,
    disabledReason: undefined,
    ...(row.account === account ? {} : { addedAt: now }),
  });
}

/** Whether accounts mode is on, whether someone is signed in, and whether this phone receives notifications. */
export const status = query({
  args: { token: v.optional(v.string()) },
  returns: v.object({ accountsMode: v.boolean(), signedIn: v.boolean(), registered: v.boolean() }),
  handler: async (ctx, { token }) => {
    const account = await currentAccount(ctx);
    const row = account && token && isPushToken(token) ? await byToken(ctx, token) : null;
    return {
      accountsMode: accessEnforced(),
      signedIn: account !== null,
      registered: !!row && row.account === account && row.disabledAt === undefined,
    };
  },
});

/** Called once the owner allowed notifications on this phone. */
export const register = mutation({
  args: { token: v.string(), platform: vPushPlatform },
  returns: v.null(),
  handler: async (ctx, { token, platform }) => {
    const account = await requireAccount(ctx);
    requireToken(token);
    await keep(ctx, account, token, platform);
    return null;
  },
});

/** Called when the app opens or the phone's token changes, so a live phone stays known and a replaced token goes. */
export const refresh = mutation({
  args: { token: v.string(), platform: vPushPlatform, previousToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { token, platform, previousToken }) => {
    const account = await requireAccount(ctx);
    requireToken(token);
    // Refuse before anything changes, so a refused refresh leaves this account's previous token in place.
    await refuseElsewhere(ctx, account, token);
    if (previousToken && previousToken !== token && isPushToken(previousToken)) {
      const previous = await byToken(ctx, previousToken);
      if (previous && previous.account === account) await ctx.db.delete(previous._id);
    }
    await keep(ctx, account, token, platform);
    return null;
  },
});

/** Stops notifications to this phone: when the owner turns them off here, and on sign-out before the session ends. */
export const remove = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const account = await requireAccount(ctx);
    if (!isPushToken(token)) return null;
    const row = await byToken(ctx, token);
    if (row && row.account === account) await ctx.db.delete(row._id);
    return null;
  },
});

/** For account deletion: removes every phone of the account, in batches, scheduling itself until none are left. */
export const removeAccount = internalMutation({
  args: { account: v.string() },
  returns: v.object({ removed: v.number(), more: v.boolean() }),
  handler: async (ctx, { account }) => {
    const rows = await ctx.db
      .query("pushTokens")
      .withIndex("by_account_and_disabled", (q) => q.eq("account", account))
      .take(REMOVE_BATCH + 1);
    for (const row of rows.slice(0, REMOVE_BATCH)) await ctx.db.delete(row._id);
    const more = rows.length > REMOVE_BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.push.devices.removeAccount, { account });
    return { removed: Math.min(rows.length, REMOVE_BATCH), more };
  },
});
