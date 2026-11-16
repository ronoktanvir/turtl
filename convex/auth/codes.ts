import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { CODE_ALPHABET, CODE_EMAILS_PER_DAY, CODE_LENGTH, CODE_VALID_HOURS } from "./rules";

// The codes turtl emails (a password reset, and confirming a new password account's address), kept only as hashes.
// Review findings 6 and 14: someone who knows only an owner's address must not be able to spoil the code in the owner's
// inbox, keep the owner locked out, or make turtl flood that inbox. So:
// - A code is 20 characters, about 100 bits (rules.ts). Guessing is hopeless, so wrong codes are not counted at all:
//   nothing a stranger sends uses anything up, and nothing is locked.
// - Asking again never replaces or cancels a code already sent. Each code works until it expires, until it is used,
//   or until another code of the same kind for the same address is used (a finished reset or confirmation ends them
//   all, so each works once).
// - At most CODE_EMAILS_PER_DAY emails of a kind go to one address in any 24 hours, and none within a minute of the
//   last. Each code works for CODE_VALID_HOURS, which is the same 24 hours, so whenever the limit stops another email
//   the newest one (sent less than 24 hours ago) still works, until the oldest leaves the window and a new one can be
//   sent. A stranger can use up the day's emails, but never leave the owner without a code that works.
// - Codes are filed under a hash of the address, not under an account: deleting an account and signing up again does
//   not reset the limit, and a code sent to an address confirms whichever password account holds that address now.

export type Purpose = "reset" | "confirm";
export const vPurpose = v.union(v.literal("reset"), v.literal("confirm"));

export const CODE_VALID_MS = CODE_VALID_HOURS * 3_600_000;
/** The window the email limit counts over: as long as a code works (see above). */
export const WINDOW_MS = CODE_VALID_MS;
/** No second email of a kind to an address within a minute of the last. */
export const RESEND_AFTER_MS = 60_000;
/** Rows the hourly sweep deletes at most. More than a day's worth at the sign-up ceilings. */
const PRUNE_BATCH = 500;

/** A new code. 32 letters, so the low five bits of each random byte pick one with no bias. */
export function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What codes are filed under: a hash of the (normalized) address, never the address. */
export const addressHash = (email: string) => sha256("turtl-email-address:" + email);
/** What a code is stored as. Takes a code already normalized (rules.ts normalizeCode). */
export const codeHash = (code: string) => sha256("turtl-email-code:" + code);

type Reader = Pick<QueryCtx, "db">;

/** The emails of this kind sent to the address in the last WINDOW_MS, newest first. */
async function recent(ctx: Reader, address: string, purpose: Purpose, now: number) {
  return await ctx.db
    .query("authEmailCodes")
    .withIndex("by_address_purpose_and_sent", (q) => q.eq("addressHash", address).eq("purpose", purpose).gt("sentAt", now - WINDOW_MS))
    .order("desc")
    .take(CODE_EMAILS_PER_DAY * 2);
}

export type Allowed = { ok: true } | { ok: false; reason: "wait" | "limit"; until: number };
export const vAllowed = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), reason: v.union(v.literal("wait"), v.literal("limit")), until: v.number() }),
);

/** Whether another email of this kind may go to the address now, and if not, from when. */
function allowance(sent: { sentAt: number }[], now: number): Allowed {
  if (sent.length >= CODE_EMAILS_PER_DAY) return { ok: false, reason: "limit", until: sent[CODE_EMAILS_PER_DAY - 1].sentAt + WINDOW_MS };
  if (sent[0] && sent[0].sentAt > now - RESEND_AFTER_MS) return { ok: false, reason: "wait", until: sent[0].sentAt + RESEND_AFTER_MS };
  return { ok: true };
}

/** For a screen: when turtl last emailed this kind of code to the address, until when the newest still works (null
 * once it is used), and from when another may be sent (null: now). */
export async function emailState(ctx: Reader, address: string, purpose: Purpose, now: number) {
  const sent = await recent(ctx, address, purpose, now);
  const allowed = allowance(sent, now);
  const newest = sent[0];
  return {
    lastSentAt: newest?.sentAt ?? null,
    worksUntil: newest && newest.usedAt === undefined && newest.expiresAt > now ? newest.expiresAt : null,
    nextSendAt: allowed.ok ? null : allowed.until,
  };
}

/** Files a code that is about to be emailed, when the limits allow another email now. The action makes the code and
 * sends it; only its hash comes here. */
export const reserve = internalMutation({
  args: { addressHash: v.string(), purpose: vPurpose, codeHash: v.string() },
  returns: vAllowed,
  handler: async (ctx, args): Promise<Allowed> => {
    const now = Date.now();
    const allowed = allowance(await recent(ctx, args.addressHash, args.purpose, now), now);
    if (!allowed.ok) return allowed;
    await ctx.db.insert("authEmailCodes", { ...args, sentAt: now, expiresAt: now + CODE_VALID_MS });
    return allowed;
  },
});

/** Takes back a code whose email could not be sent, so it neither works nor counts against the address. */
export const release = internalMutation({
  args: { addressHash: v.string(), purpose: vPurpose, codeHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const row of await recent(ctx, args.addressHash, args.purpose, Date.now())) {
      if (row.codeHash === args.codeHash && row.usedAt === undefined) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * Uses a code: true when it is one of the codes of this kind emailed to the address, not used and not expired. Using
 * it uses every other code of that kind for the address, so a reset or a confirmation happens once. A wrong code
 * changes nothing and is counted nowhere.
 */
export async function useCode(ctx: Pick<MutationCtx, "db">, address: string, purpose: Purpose, hash: string): Promise<boolean> {
  const now = Date.now();
  const sent = await recent(ctx, address, purpose, now);
  const match = sent.find((row) => row.codeHash === hash && row.usedAt === undefined && row.expiresAt > now);
  if (!match) return false;
  for (const row of sent) if (row.usedAt === undefined) await ctx.db.patch(row._id, { usedAt: now });
  return true;
}

export const redeem = internalMutation({
  args: { addressHash: v.string(), purpose: vPurpose, codeHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => await useCode(ctx, args.addressHash, args.purpose, args.codeHash),
});

/** After a reset that worked: forgets the account's count of wrong passwords, which Convex Auth keeps under the
 * account's id, so the new password is not refused because someone else guessed wrong. */
export const forgetWrongPasswords = internalMutation({
  args: { accountId: v.id("authAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }: { accountId: Id<"authAccounts"> }) => {
    for (const limit of await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", accountId)).take(10)) {
      await ctx.db.delete(limit._id);
    }
    return null;
  },
});

/** Hourly (convex/crons.ts): deletes the record of every email sent more than a day ago. Those codes have expired and
 * no longer count against their address. */
export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const old = await ctx.db.query("authEmailCodes").withIndex("by_sent", (q) => q.lt("sentAt", Date.now() - WINDOW_MS)).take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    return old.length;
  },
});
