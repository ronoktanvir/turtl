import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { action, mutation, query } from "../functions";
import { accessEnforced, pendingAccount, SIGN_IN_REQUIRED, signedInAccount } from "../access";
import { beginDeletion } from "../account/deletion";
import { admitNewAccount } from "../spend/ceilings";
import { addressHash, codeHash, emailState, useCode } from "./codes";
import { addressConfirmed, markAddressConfirmed, unconfirmedRow } from "./confirmed";
import { domainRefusal } from "./domains";
import { emailCode } from "./email";
import { CODE_EMAILS_PER_DAY, normalizeCode, normalizeEmail, UNCONFIRMED_DAYS, words } from "./rules";

// Confirming a new password account's email address (review findings 7 and 12). With accounts on, a password sign-up
// makes an account that reaches nothing (convex/access.ts reads it as signed out) until its owner enters the code
// turtl emailed to the address, or taps the link that fills it in. Accounts made with Sign in with Apple or GitHub
// count as confirmed. Until then the app shows one screen, "Check your email", and these are its functions:
// status, confirm, resend (limited per address, codes.ts) and startOver (deletes this account, to sign up again with
// another address). An account never confirmed is deleted UNCONFIRMED_DAYS after sign-up (sweep).
//
// The operator can confirm an account without a code, for the App Review account, whose address may not be a real
// mailbox:  npx convex run auth/confirmation:markConfirmed '{"email":"review@example.com"}'
// (auth/review:ensureAccount does this itself for the account it makes).

export const UNCONFIRMED_MS = UNCONFIRMED_DAYS * 24 * 3_600_000;
/** Accounts the hourly sweep starts deleting at most. A day's password sign-ups at the default ceiling is 200. */
const SWEEP_BATCH = 50;

export const NOTHING_TO_CONFIRM = "There's nothing to confirm for this account.";
const resent = (email: string) => `turtl sent a new email to ${email}. It can take a minute to arrive; check your spam folder too.`;
const waitWords = "turtl sent you an email less than a minute ago. Give it a moment to arrive, and check your spam folder too.";
const limitWords = `turtl has sent this address ${CODE_EMAILS_PER_DAY} emails today, the most it sends in a day. The newest one still works: tap its link or copy its code.`;

async function emailOf(ctx: { db: { get: (id: Id<"users">) => Promise<{ email?: string } | null> } }, account: string): Promise<string | null> {
  return normalizeEmail((await ctx.db.get(account as Id<"users">))?.email);
}

/** What the "check your email" screen shows. Null unless the caller is a password account waiting to confirm. */
export const status = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      /** When turtl last emailed a code to the address, in the last day. */
      lastSentAt: v.union(v.number(), v.null()),
      /** Until when the newest code works. */
      worksUntil: v.union(v.number(), v.null()),
      /** From when another email can be sent; null for now. */
      nextSendAt: v.union(v.number(), v.null()),
      /** When this account is deleted if it is never confirmed. */
      removedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const account = await pendingAccount(ctx);
    const email = account ? await emailOf(ctx, account) : null;
    if (!account || !email) return null;
    const row = await unconfirmedRow(ctx.db, account);
    const state = await emailState(ctx, await addressHash(email), "confirm", Date.now());
    return { email, ...state, removedAt: (row?.since ?? Date.now()) + UNCONFIRMED_MS };
  },
});

/** Confirms the caller's address with a code from the email. Nothing happens until the person taps Confirm: the
 * email's link only fills the code in. */
export const confirm = mutation({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, { code }) => {
    const account = await pendingAccount(ctx);
    if (!account) {
      // Confirmed already (a second tap, or another device): nothing to do.
      if (await signedInAccount(ctx)) return null;
      throw new ConvexError(SIGN_IN_REQUIRED);
    }
    const normalized = normalizeCode(code);
    const email = await emailOf(ctx, account);
    if (!normalized || !email) throw new ConvexError(words.wrongCode);
    // The ceiling on confirmations comes first. Any refusal below undoes it, and leaves the code unused.
    await admitNewAccount(ctx, "confirmation", email);
    if (!(await useCode(ctx, await addressHash(email), "confirm", await codeHash(normalized)))) throw new ConvexError(words.wrongCode);
    await markAddressConfirmed(ctx, account);
    return null;
  },
});

/** Emails the caller a new code, when the limits allow (codes.ts). Codes already sent keep working. */
export const resend = action({
  args: {},
  returns: v.object({ sent: v.boolean(), message: v.string() }),
  handler: async (ctx): Promise<{ sent: boolean; message: string }> => {
    const account: string | null = await ctx.runQuery(internal.access.pending, {});
    const email: string | null = account ? await ctx.runQuery(internal.auth.confirmation.addressOf, { account }) : null;
    if (!account || !email) throw new ConvexError(SIGN_IN_REQUIRED);
    const allowed = await emailCode(ctx, email, "confirm");
    if (allowed.ok) return { sent: true, message: resent(email) };
    const message = { wait: waitWords, limit: limitWords, ceiling: domainRefusal.emailsToday, domain: domainRefusal.domainEmailsToday }[allowed.reason];
    return { sent: false, message };
  },
});

/** Throws this unconfirmed account away, so its owner can sign up again with another address. The address is free
 * again at once; the rest goes through account deletion (convex/account). Only an unconfirmed account can do this. */
export const startOver = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const account = await pendingAccount(ctx);
    if (!account) throw new ConvexError(SIGN_IN_REQUIRED);
    await beginDeletion(ctx, account);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------- internal

/** Whether this account has confirmed its address, or never had to (Apple, GitHub, accounts made before confirmation
 * existed). For operator commands that prepare an account for someone, such as practice/review:prepare. */
export const isConfirmed = internalQuery({
  args: { account: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { account }) => await addressConfirmed(ctx.db, account),
});

export const addressOf = internalQuery({
  args: { account: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { account }) => (ctx.db.normalizeId("users", account) ? await emailOf(ctx, account) : null),
});

/**
 * For the operator: confirms the password account with this address without a code, as for the App Review account,
 * whose address may not be a real mailbox. It counts against no ceiling.
 *   npx convex run auth/confirmation:markConfirmed '{"email":"review@example.com"}'
 */
export const markConfirmed = internalMutation({
  args: { email: v.string() },
  returns: v.object({ email: v.string(), wasWaiting: v.boolean() }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email) throw new ConvexError(words.badEmail);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
      .unique();
    if (!account) throw new ConvexError(`There's no account with a password for ${email}.`);
    return { email, wasWaiting: await markAddressConfirmed(ctx, account.userId) };
  },
});

/** Hourly (convex/crons.ts): starts deleting every password account that has not confirmed its address within
 * UNCONFIRMED_DAYS of signing up. Deleting ends its sessions and frees its address at once (convex/account). */
export const sweep = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if (!accessEnforced()) return 0;
    const stale = await ctx.db.query("authUnconfirmed").withIndex("by_since", (q) => q.lt("since", Date.now() - UNCONFIRMED_MS)).take(SWEEP_BATCH);
    for (const row of stale) await beginDeletion(ctx, row.account);
    return stale.length;
  },
});
