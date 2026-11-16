import { Email } from "@convex-dev/auth/providers/Email";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { resetEmail } from "./settings";
import { words } from "./rules";

// The emailed code that resets a password. It exists only when AUTH_RESEND_KEY and AUTH_EMAIL_FROM are set;
// without them the Password provider has no reset and the app points people at support.
// The one outside call is sendResetCode below, to Resend's API. Swapping the email service means rewriting that
// function and its two variables, nothing else.

export const RESET_PROVIDER_ID = "password-reset";
export const RESET_CODE_LENGTH = 8;
const RESET_CODE_MINUTES = 15;

function randomCode(): string {
  const bytes = new Uint8Array(RESET_CODE_LENGTH);
  // 250 is the largest multiple of 10 below 256, so every digit is equally likely.
  const digits: string[] = [];
  while (digits.length < RESET_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) if (byte < 250 && digits.length < RESET_CODE_LENGTH) digits.push(String(byte % 10));
  }
  return digits.join("");
}

export function resetMessage(code: string): { subject: string; text: string } {
  return {
    subject: `Your turtl code is ${code}`,
    text: [
      `Someone asked to reset the password for your turtl account. Enter this code in the app to choose a new password:`,
      ``,
      code,
      ``,
      `It works once and for ${RESET_CODE_MINUTES} minutes. If you didn't ask, ignore this email: your password stays the same.`,
    ].join("\n"),
  };
}

export async function sendResetCode(to: string, code: string, fetcher: typeof fetch = fetch): Promise<void> {
  const settings = resetEmail();
  if (!settings) throw new ConvexError(words.resetOff);
  const { subject, text } = resetMessage(code);
  const response = await fetcher(settings.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: settings.from, to: [to], subject, text }),
  });
  if (!response.ok) {
    // The reply can echo the address; log only the status.
    console.error(`The reset email was not accepted (HTTP ${response.status}).`);
    throw new ConvexError("turtl couldn't send the email just now. Try again in a few minutes.");
  }
}

// Someone who knows only an owner's email address must not be able to keep that owner out (review finding 6). Convex
// Auth replaces an account's code whenever it sends another, and counts wrong codes against the email address, so a
// stranger could keep replacing the code the owner was sent, or use up the address's tries so the owner's right code
// is refused. turtl therefore:
// - never replaces a code that still works: a second request while one is live sends nothing, and the first still
//   works (the owner's inbox holds it, whoever asked);
// - counts wrong codes against the code: each code takes MAX_CODE_TRIES tries and is then dropped, and anyone may
//   ask for a fresh one, which only the owner receives. The address itself is never locked;
// - clears the account's wrong-password count when a reset succeeds, so the new password works at once everywhere.
// Convex Auth still counts wrong passwords per account before it checks the password (10 an hour); a stranger can
// keep that count spent, and this reset is the owner's way back in. Telling the owner's own device apart from a
// stranger's (App Attest) is out of scope here.

/** At most one reset email a minute for an account, so the form cannot be used to flood someone's inbox or the
 * email bill, and never while the account's last code still works. */
export const RESEND_AFTER_MS = 60_000;
/** Tries one reset code takes, right or wrong, before it is dropped and a new one must be asked for. */
export const MAX_CODE_TRIES = 5;

type Ctx = Pick<MutationCtx, "db">;

const codeOf = (ctx: Ctx, accountId: Id<"authAccounts">) =>
  ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", accountId)).unique();
const resetOf = (ctx: Ctx, accountId: Id<"authAccounts">) =>
  ctx.db.query("authPasswordResets").withIndex("accountId", (q) => q.eq("accountId", accountId)).unique();

/** The account's reset code while it can still be tried: not expired, and not out of tries. */
async function liveCode(ctx: Ctx, accountId: Id<"authAccounts">) {
  const code = await codeOf(ctx, accountId);
  if (!code || code.provider !== RESET_PROVIDER_ID || code.expirationTime <= Date.now()) return null;
  const tries = (await resetOf(ctx, accountId))?.tries ?? 0;
  return tries < MAX_CODE_TRIES ? { code, tries } : null;
}

/** Whether to send a new code now. Yes only when no code still works and none was sent in the last minute; a yes
 * starts the new code's count of tries. */
export const reserveReset = internalMutation({
  args: { accountId: v.id("authAccounts") },
  returns: v.boolean(),
  handler: async (ctx, { accountId }) => {
    if (await liveCode(ctx, accountId)) return false;
    const now = Date.now();
    const reset = await resetOf(ctx, accountId);
    if (reset && reset.requestedAt > now - RESEND_AFTER_MS) return false;
    if (reset) await ctx.db.patch(reset._id, { requestedAt: now, tries: 0 });
    else await ctx.db.insert("authPasswordResets", { accountId, requestedAt: now, tries: 0 });
    return true;
  },
});

/** Takes one try of the account's code before it is checked. False when there is no code that can still be tried; a
 * code that has used all its tries is dropped here, so a new one can be asked for. */
export const takeResetTry = internalMutation({
  args: { accountId: v.id("authAccounts") },
  returns: v.boolean(),
  handler: async (ctx, { accountId }) => {
    const code = await codeOf(ctx, accountId);
    if (!code || code.provider !== RESET_PROVIDER_ID || code.expirationTime <= Date.now()) return false;
    const reset = await resetOf(ctx, accountId);
    const tries = reset?.tries ?? 0;
    if (tries >= MAX_CODE_TRIES) {
      await ctx.db.delete(code._id);
      return false;
    }
    if (reset) await ctx.db.patch(reset._id, { tries: tries + 1 });
    else await ctx.db.insert("authPasswordResets", { accountId, requestedAt: code._creationTime, tries: 1 });
    return true;
  },
});

/** After a reset that worked: forgets the reset, and the account's count of wrong passwords, which Convex Auth keeps
 * under the account's id, so the new password is not refused because someone else guessed wrong. */
export const finishReset = internalMutation({
  args: { accountId: v.id("authAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const reset = await resetOf(ctx, accountId);
    if (reset) await ctx.db.delete(reset._id);
    for (const limit of await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", accountId)).take(10)) {
      await ctx.db.delete(limit._id);
    }
    return null;
  },
});

/** The provider Convex Auth sends and checks reset codes through, or undefined when reset is switched off. Codes are
 * checked by account (password.ts passes the account's id, not the address), so Convex Auth's count of wrong codes per
 * address never applies; the account check replaces the provider's default check of the address. */
export function resetProvider() {
  if (!resetEmail()) return undefined;
  return Email({
    id: RESET_PROVIDER_ID,
    maxAge: RESET_CODE_MINUTES * 60,
    generateVerificationToken: async () => randomCode(),
    sendVerificationRequest: async ({ identifier, token }) => sendResetCode(identifier, token),
    // Convex Auth has already matched the code to the account it was asked for (verifyCodeOnly's accountId check).
    authorize: async () => {},
  });
}
