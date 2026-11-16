import { Email } from "@convex-dev/auth/providers/Email";
import { ConvexError } from "convex/values";
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

/** The provider Convex Auth sends and checks reset codes through, or undefined when reset is switched off. */
export function resetProvider() {
  if (!resetEmail()) return undefined;
  return Email({
    id: RESET_PROVIDER_ID,
    maxAge: RESET_CODE_MINUTES * 60,
    generateVerificationToken: async () => randomCode(),
    sendVerificationRequest: async ({ identifier, token }) => sendResetCode(identifier, token),
  });
}
