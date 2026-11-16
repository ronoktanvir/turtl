import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { bump, countOf, dayWindow, DEPLOYMENT, domainKey, pruneCounts, unbump, type CountName } from "./counts";
import { domainCap } from "./domains";
import { CODE_ALPHABET, CODE_EMAILS_PER_DAY, CODE_LENGTH, CODE_VALID_HOURS } from "./rules";
import { emailsPerDay } from "./settings";

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

/** "wait" and "limit": this address's emails (above). "ceiling": the deployment's emails today. "domain": emails to
 * addresses at this email domain today. */
export type Allowed = { ok: true } | { ok: false; reason: "wait" | "limit" | "ceiling" | "domain"; until: number };
export const vAllowed = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), reason: v.union(v.literal("wait"), v.literal("limit"), v.literal("ceiling"), v.literal("domain")), until: v.number() }),
);

// The day's emails (findings 19 and 24). EMAILS_PER_DAY is the day's pool (UTC), so an operator can fit it to their
// email plan. Emails anyone can cause by signing up (every confirmation email, and a reset of an account that has not
// confirmed its address) may use only SIGNUP_EMAIL_SHARE of it; resets may use what is left, and one email domain may
// take only its share of either (convex/auth/domains.ts). When the pool runs out, codes already sent keep working.
//
// Each confirmed address's first reset email of a UTC day stands outside the pool and the domain shares (finding 24):
// however the pool was used up, an owner who needs a reset gets one a day. If a stranger asked first, that email went to
// the owner, and its code works for 24 hours, past the end of the day; so at every moment the owner holds a working
// code or can be sent one. The five a day per address still bound what one address receives, so this adds at most one
// email a day per confirmed password account someone asks about.

/** "reset": a reset of an account whose address is confirmed. "signup": anything a sign-up can cause. */
export type Side = "reset" | "signup";
export const vSide = v.union(v.literal("reset"), v.literal("signup"));
export const SIGNUP_EMAIL_SHARE = 2 / 3;
export const signUpEmailsPerDay = () => Math.max(1, Math.floor(emailsPerDay() * SIGNUP_EMAIL_SHARE));
const tomorrow = (now: number) => Date.parse(dayWindow(now) + "T00:00:00Z") + 24 * 3_600_000;

/** Whether the day's pool leaves room for one more email of this side to an address at this domain. */
async function dayRoom(ctx: Reader, domain: string, side: Side, now: number): Promise<Allowed> {
  const day = dayWindow(now);
  const refused = (reason: "ceiling" | "domain"): Allowed => ({ ok: false, reason, until: tomorrow(now) });
  if ((await countOf(ctx, "emails_day", DEPLOYMENT, day)) >= emailsPerDay()) return refused("ceiling");
  const key = await domainKey(domain);
  if (side === "reset") {
    // Resets for many addresses at one domain cannot fill the day either.
    if ((await countOf(ctx, "domain_reset_emails_day", key, day)) >= domainCap(emailsPerDay(), domain)) return refused("domain");
    return { ok: true };
  }
  if ((await countOf(ctx, "signup_emails_day", DEPLOYMENT, day)) >= signUpEmailsPerDay()) return refused("ceiling");
  if ((await countOf(ctx, "domain_signup_emails_day", key, day)) >= domainCap(signUpEmailsPerDay(), domain)) return refused("domain");
  return { ok: true };
}

/** A confirmed address's first reset email of the UTC day: none sent to it since midnight. */
const firstResetToday = (sent: { sentAt: number }[], now: number) => !sent.some((row) => row.sentAt >= Date.parse(dayWindow(now) + "T00:00:00Z"));

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

const vFiled = { addressHash: v.string(), purpose: vPurpose, codeHash: v.string(), domain: v.string(), side: vSide };

/** The day's counts an email adds to (or, taken back, takes from). A confirmed address's first reset of the day counts
 * only on its own line, outside the pool. */
async function countEmail(ctx: Pick<MutationCtx, "db">, domain: string, side: Side, firstOfDay: boolean, at: number, step: 1 | -1) {
  const day = dayWindow(at);
  const key = await domainKey(domain);
  const counts: [CountName, string][] = firstOfDay
    ? [["first_resets_day", DEPLOYMENT]]
    : side === "reset"
      ? [["emails_day", DEPLOYMENT], ["domain_reset_emails_day", key]]
      : [["emails_day", DEPLOYMENT], ["signup_emails_day", DEPLOYMENT], ["domain_signup_emails_day", key]];
  for (const [name, countKey] of counts) await (step === 1 ? bump(ctx, name, countKey, day) : unbump(ctx, name, countKey, day));
}

/** Files a code that is about to be emailed, when the limits allow another email now: this address's (five a day,
 * one a minute), then the day's (above). The action makes the code and sends it; only its hash comes here. */
export const reserve = internalMutation({
  args: vFiled,
  returns: vAllowed,
  handler: async (ctx, { domain, side, ...code }): Promise<Allowed> => {
    const now = Date.now();
    const sent = await recent(ctx, code.addressHash, code.purpose, now);
    const allowed = allowance(sent, now);
    if (!allowed.ok) return allowed;
    const firstOfDay = side === "reset" && code.purpose === "reset" && firstResetToday(sent, now);
    if (!firstOfDay) {
      const room = await dayRoom(ctx, domain, side, now);
      if (!room.ok) return room;
    }
    await countEmail(ctx, domain, side, firstOfDay, now, 1);
    await ctx.db.insert("authEmailCodes", { ...code, sentAt: now, expiresAt: now + CODE_VALID_MS, ...(firstOfDay && { firstOfDay: true }) });
    return allowed;
  },
});

/** Takes back a code whose email could not be sent, so it neither works nor counts against the address or the day. */
export const release = internalMutation({
  args: vFiled,
  returns: v.null(),
  handler: async (ctx, { domain, side, ...code }) => {
    const now = Date.now();
    for (const row of await recent(ctx, code.addressHash, code.purpose, now)) {
      if (row.codeHash === code.codeHash && row.usedAt === undefined) {
        await ctx.db.delete(row._id);
        await countEmail(ctx, domain, side, row.firstOfDay === true, row.sentAt, -1);
      }
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

/** Hourly (convex/crons.ts): deletes the record of every email sent more than a day ago (those codes have expired and
 * no longer count against their address), and the day counts of days before today. */
export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const old = await ctx.db.query("authEmailCodes").withIndex("by_sent", (q) => q.lt("sentAt", now - WINDOW_MS)).take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    // And the counts per email domain and per day, from before today.
    return old.length + (await pruneCounts(ctx, now, PRUNE_BATCH));
  },
});
