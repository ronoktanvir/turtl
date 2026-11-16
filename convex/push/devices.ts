import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { mutation, query } from "../functions";
import { accessEnforced, callerSession, currentAccount, requireAccount, sessionLive } from "../access";
import { vPushPlatform } from "./schema";

// The phones that receive an account's push notifications. Every public function asks convex/access.ts who is
// calling, and a phone only ever acts on its own token under the caller's account.
//
// With accounts on, a phone is registered under the sign-in session that turned its notifications on, and receives
// the account's notifications only while that session is live (receives, below). Signing out, a password reset and
// account deletion end sessions, and so does running out: from then on delivery skips the phone, another account may
// register it, and forgetEnded (at a reset) or the hourly sweep removes it. A refresh keeps a phone current for the
// account it is registered under and never registers one, so a phone handed to the next account does not start
// receiving that account's notifications until it turns them on. The single-owner demo keeps no sessions, as before.

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

/** Whether this phone receives its account's notifications: not turned off and, with accounts on, registered under a
 * session that is still live. A phone registered by a caller naming no session (noSession) is live until removed; one
 * registered before sessions were kept names neither, and receives nothing until its app files it again (refresh). */
export async function receives(ctx: Pick<QueryCtx, "db">, row: Doc<"pushTokens">): Promise<boolean> {
  if (row.disabledAt !== undefined) return false;
  if (!accessEnforced() || row.noSession) return true;
  return row.sessionId !== undefined && (await sessionLive(ctx, row.sessionId));
}

/** What a registration is tied to: the caller's session with accounts on, nothing in the demo. */
async function tiedTo(ctx: Pick<QueryCtx, "auth" | "db">): Promise<{ sessionId?: Id<"authSessions">; noSession?: true }> {
  if (!accessEnforced()) return {};
  const sessionId = await callerSession(ctx);
  return sessionId ? { sessionId, noSession: undefined } : { sessionId: undefined, noSession: true };
}

/** The token's row, or a refusal when it is live on another account (review finding 11): a phone whose session is
 * still live. One whose session has ended no longer belongs to anyone, and the next account may take it. */
async function refuseElsewhere(ctx: MutationCtx, account: string, token: string) {
  const row = await byToken(ctx, token);
  if (row && row.account !== account && (await receives(ctx, row))) throw new ConvexError(TOKEN_IN_USE);
  return row;
}

/** Deletes the account's phones that no longer receive its notifications because their session ended. */
async function forgetEndedPhones(ctx: MutationCtx, account: string): Promise<number> {
  if (!accessEnforced()) return 0;
  const rows = await ctx.db
    .query("pushTokens")
    .withIndex("by_account_and_disabled", (q) => q.eq("account", account).eq("disabledAt", undefined))
    .take(MAX_LIVE_TOKENS + REMOVE_BATCH);
  let removed = 0;
  for (const row of rows) {
    if (await receives(ctx, row)) continue;
    await ctx.db.delete(row._id);
    removed += 1;
  }
  return removed;
}

/** Files this token under the account as a live phone, tied to the caller's session. A token that is live on another
 * account is refused: anyone who learned it could otherwise move that owner's notifications to themselves. Signing out
 * frees it (remove, or the session's end), and a token that account no longer uses (disabled) moves. */
async function keep(ctx: MutationCtx, account: string, token: string, platform: Doc<"pushTokens">["platform"], tie: Awaited<ReturnType<typeof tiedTo>>) {
  const now = Date.now();
  const row = await refuseElsewhere(ctx, account, token);
  const liveHere = row && row.account === account && row.disabledAt === undefined;
  if (!liveHere) {
    await forgetEndedPhones(ctx, account);
    await makeRoom(ctx, account, now);
  }
  if (!row) {
    await ctx.db.insert("pushTokens", { account, token, platform, addedAt: now, lastSeenAt: now, ...tie });
    return;
  }
  await ctx.db.patch(row._id, {
    account,
    platform,
    lastSeenAt: now,
    disabledAt: undefined,
    disabledReason: undefined,
    ...tie,
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
      registered: !!row && row.account === account && (await receives(ctx, row)),
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
    await keep(ctx, account, token, platform, await tiedTo(ctx));
    return null;
  },
});

/** Called when the app opens or the phone's token changes, so a live phone stays known, a replaced token goes, and the
 * phone is tied to the session it is signed in with now. True when the phone is this account's; false (with accounts
 * on) when it is not, and then nothing is registered: only turning notifications on does that (register). */
export const refresh = mutation({
  args: { token: v.string(), platform: vPushPlatform, previousToken: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { token, platform, previousToken }) => {
    const account = await requireAccount(ctx);
    requireToken(token);
    // Refuse before anything changes, so a refused refresh leaves this account's previous token in place.
    const row = await refuseElsewhere(ctx, account, token);
    const previous = previousToken && previousToken !== token && isPushToken(previousToken) ? await byToken(ctx, previousToken) : null;
    const mine = (found: Doc<"pushTokens"> | null) => found?.account === account;
    if (accessEnforced() && !mine(row) && !mine(previous)) return false;
    if (previous && mine(previous)) await ctx.db.delete(previous._id);
    await keep(ctx, account, token, platform, await tiedTo(ctx));
    return true;
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

/** At a password reset, which ends every session of the account (convex/auth/password.ts): removes its phones at once. */
export const forgetEnded = internalMutation({
  args: { account: v.string() },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, { account }) => ({ removed: await forgetEndedPhones(ctx, account) }),
});

const SWEEP_BATCH = 200;

/** Every hour (convex/crons.ts): removes the phones whose session ended in any other way (signed out where the phone
 * could not say so, ran out), and those registered before sessions were kept that no app has filed again. A phone
 * Expo turned off stays, as the record of that. Nothing in the demo. */
export const sweep = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({ removed: v.number(), more: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    if (!accessEnforced()) return { removed: 0, more: false };
    const page = await ctx.db.query("pushTokens").paginate({ cursor: cursor ?? null, numItems: SWEEP_BATCH });
    let removed = 0;
    for (const row of page.page) {
      if (row.disabledAt !== undefined || (await receives(ctx, row))) continue;
      await ctx.db.delete(row._id);
      removed += 1;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.push.devices.sweep, { cursor: page.continueCursor });
    return { removed, more: !page.isDone };
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
