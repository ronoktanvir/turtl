import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { addressHash, codeHash, randomCode, type Allowed, type Purpose } from "./codes";
import { APP_LINK_PREFIX, CODE_VALID_HOURS, formatCode, UNCONFIRMED_DAYS, words } from "./rules";
import { emailService } from "./settings";

// What turtl emails, and the one outside call that sends it: sendEmail, to Resend's API. There are two emails, both
// with a code (codes.ts says how codes are limited and why a stranger cannot spoil one): one to reset a password, one
// to confirm the address of a new password account. Both go out only when AUTH_RESEND_KEY and AUTH_EMAIL_FROM are set.
// Swapping the email service means rewriting sendEmail and those two variables, nothing else.
//
// Each email carries a turtl:// link with the code in it, and the code itself to paste. The link only opens turtl on
// the right screen with the code filled in; nothing happens until the person taps the button there.

export type Message = { subject: string; text: string; html: string };

/**
 * The link in an email: it opens turtl's reset or confirm screen with the code filled in, and nothing else. It never
 * carries the address (finding 21): a reset link someone forwards from their own account must not be able to name
 * whose password the person who taps it is about to set. The reset screen takes the address from this phone's own
 * request, or from the person; the code works only for the address it was sent to.
 * The parameter is emailCode, not code: Convex Auth's provider in a browser takes a ?code= in the page's address for
 * its own sign-in codes.
 */
export function codeLink(purpose: Purpose, code: string): string {
  return `${APP_LINK_PREFIX}${purpose === "reset" ? "reset-password" : "confirm-email"}?emailCode=${formatCode(code)}`;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The same few plain paragraphs as text and as HTML (so the link can be tapped), with nothing else. */
function compose(paragraphs: { intro: string; linkLabel: string; screen: string; after: string }, link: string, code: string): Omit<Message, "subject"> {
  const shown = formatCode(code);
  const text = [paragraphs.intro, "", link, "", `Or copy this code into turtl's "${paragraphs.screen}" screen:`, "", shown, "", paragraphs.after].join("\n");
  const html = [
    `<p>${escape(paragraphs.intro)}</p>`,
    `<p><a href="${escape(link)}">${escape(paragraphs.linkLabel)}</a></p>`,
    `<p>Or copy this code into turtl's "${escape(paragraphs.screen)}" screen:</p>`,
    `<p style="font-family:Menlo,Consolas,monospace;font-size:18px">${shown}</p>`,
    `<p>${escape(paragraphs.after)}</p>`,
  ].join("\n");
  return { text, html };
}

/** The email that resets a password. Never holds a password. */
export function resetMessage(email: string, code: string): Message {
  return {
    subject: "Reset your turtl password",
    ...compose(
      {
        intro: `Someone asked to reset the password of the turtl account for ${email}. To choose a new password, open this link on the phone where you asked:`,
        linkLabel: "Choose a new password in turtl",
        screen: "Reset your password",
        after: `The code works once, for ${CODE_VALID_HOURS} hours, and only for ${email}. If you didn't ask for this, ignore this email: your password stays the same.`,
      },
      codeLink("reset", code),
      code,
    ),
  };
}

/** The email that confirms a new password account's address. */
export function confirmMessage(email: string, code: string): Message {
  return {
    subject: "Confirm your email address for turtl",
    ...compose(
      {
        intro: "Someone made a turtl account with this email address. To confirm it's yours, open this link on the phone where you use turtl:",
        linkLabel: "Confirm my email in turtl",
        screen: "Check your email",
        after: `The code works for ${CODE_VALID_HOURS} hours. If you didn't make a turtl account, ignore this email: the account can't do anything, and turtl deletes it after ${UNCONFIRMED_DAYS} days.`,
      },
      codeLink("confirm", code),
      code,
    ),
  };
}

export async function sendEmail(to: string, message: Message, fetcher: typeof fetch = fetch): Promise<void> {
  const settings = emailService();
  if (!settings) throw new ConvexError(words.resetOff);
  const response = await fetcher(settings.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: settings.from, to: [to], subject: message.subject, text: message.text, html: message.html }),
  });
  if (!response.ok) {
    // The reply can echo the address; log only the status.
    console.error(`turtl's email was not accepted (HTTP ${response.status}).`);
    throw new ConvexError(words.emailNotSent);
  }
}

/**
 * Emails a new code of this kind to the address, when the limits allow another email now (codes.ts). The code is made
 * here, filed by its hash, and exists in plain text only in the email. A send that fails takes the code back, so it
 * neither works nor counts against the address.
 */
export async function emailCode(ctx: Pick<ActionCtx, "runMutation">, email: string, purpose: Purpose, fetcher?: typeof fetch): Promise<Allowed> {
  if (!emailService()) throw new ConvexError(purpose === "reset" ? words.resetOff : words.signUpOff);
  const code = randomCode();
  const filed = { addressHash: await addressHash(email), purpose, codeHash: await codeHash(code) };
  const allowed: Allowed = await ctx.runMutation(internal.auth.codes.reserve, filed);
  if (!allowed.ok) return allowed;
  try {
    await sendEmail(email, purpose === "reset" ? resetMessage(email, code) : confirmMessage(email, code), fetcher);
  } catch (error) {
    await ctx.runMutation(internal.auth.codes.release, filed);
    throw error;
  }
  return allowed;
}
