// Rules and words for sign-in that the backend enforces and the app repeats before it asks. Pure: no Convex imports,
// so the app can load this file too.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** What the owner reads when something about signing in goes wrong. One place, so the app and backend agree. */
export const words = {
  wrongPassword: "That email and password don't match. Check them and try again, or reset your password.",
  // Says plainly that the address has an account, though that tells anyone who tries it: a sign-up that works signs in
  // at once, so a refusal reads differently whatever its words. Hiding it needs a code emailed either way (see
  // convex/auth/README.md on email checks). Signing in and reset never say whether an address has an account.
  accountExists: "There's already an account for this email. Log in instead, or reset your password if you've forgotten it.",
  weakPassword: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters that isn't easy to guess.`,
  passwordTooLong: `Choose a password of at most ${MAX_PASSWORD_LENGTH} characters.`,
  passwordIsEmail: "Choose a password that isn't your email address.",
  badEmail: "Enter your email address, like name@example.com.",
  tooManyTries: "Too many wrong passwords for this account. Reset your password to get back in now, or wait an hour and try again.",
  wrongCode: "That code didn't work. Copy the whole code from the newest email from turtl, or tap the link in it.",
  // One answer for a mistyped code, a used or expired one, and one emailed to another address, so it never says whose
  // code it is (finding 21).
  wrongResetCode: "That code doesn't work for this email address. Check the address, and use the newest email turtl sent to it.",
  resetOff: "Password reset by email isn't available yet. Contact support and we'll help you back in.",
  signUpOff: "Signing up with an email address isn't available on this server yet. Sign up with Apple or GitHub instead.",
  emailNotSent: "turtl couldn't send the email just now. Try again in a few minutes.",
  appleRefused: "Apple didn't confirm this sign-in. Try Sign in with Apple again.",
  appleElsewhere: "Sign in with Apple works in the turtl app on iPhone. Here, log in with your email and password or with GitHub.",
  githubRefused: "GitHub didn't confirm this sign-in. Try Sign in with GitHub again.",
  githubOff: "Sign in with GitHub isn't set up on this server yet. Use your email and password, or Sign in with Apple.",
  offline: "You're offline. Connect to the internet and try again.",
  slow: "turtl couldn't reach its server. Check your connection and try again.",
  unknown: "Something went wrong while signing in. Try again in a moment.",
} as const;

// The passwords people pick first. A short list on purpose: it catches the obvious, and length does the rest.
const COMMON = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "12345678", "123456789", "1234567890", "87654321",
  "11111111", "00000000", "qwertyui", "qwerty123", "qwertyuiop", "1q2w3e4r", "1qaz2wsx", "abcd1234", "abc12345",
  "iloveyou", "sunshine", "princess", "football", "baseball", "superman", "trustno1", "letmein1", "welcome1",
  "admin123", "changeme", "turtl123", "turtlturtl",
]);

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

/** Why this password cannot be used, in the owner's words, or null when it can. */
export function passwordProblem(password: unknown, email?: string | null): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) return words.weakPassword;
  if (password.length > MAX_PASSWORD_LENGTH) return words.passwordTooLong;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return words.weakPassword;
  if (email && lower === email.toLowerCase()) return words.passwordIsEmail;
  return null;
}

// Codes turtl emails: one to reset a password, one to confirm the address of a new password account. Each is 20
// letters and digits from Crockford's alphabet (no I, L, O or U), about 100 bits, so guessing is hopeless and there is
// no count of wrong tries for a stranger to use up. People paste it, or tap the email's turtl:// link, which fills it in.

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 20;
/** How long an emailed code works. As long as the window of CODE_EMAILS_PER_DAY, so the newest email always works
 * until another can be sent (convex/auth/codes.ts says why). */
export const CODE_VALID_HOURS = 24;
/** Emails of one kind (reset, or confirm) turtl sends one address in any 24 hours. */
export const CODE_EMAILS_PER_DAY = 5;
/** A password account that never confirms its address is deleted this many days after sign-up. */
export const UNCONFIRMED_DAYS = 7;

/** The code as typed or pasted: any case, spaces, dashes and the look-alikes O, I and L allowed. Null unless it is a
 * whole code. */
export function normalizeCode(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 200) return null;
  const cleaned = text.toUpperCase().replace(/[\s\-_.]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const character of cleaned) if (!CODE_ALPHABET.includes(character)) return null;
  return cleaned;
}

/** "ABCDE-FGHJK-MNPQR-STVWX": how a code is shown in an email. */
export function formatCode(code: string): string {
  return (code.match(/.{1,5}/g) ?? []).join("-");
}

/** Only the app's own link and the configured site may receive a sign-in code. */
export const APP_LINK_PREFIX = "turtl://";

export function allowedRedirect(redirectTo: string, siteUrl: string): string | null {
  const site = siteUrl.replace(/\/$/, "");
  if (redirectTo.startsWith(APP_LINK_PREFIX)) return redirectTo;
  if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) return redirectTo.startsWith("//") ? null : `${site}${redirectTo}`;
  if (redirectTo.startsWith(site)) {
    const after = redirectTo[site.length];
    if (after === undefined || after === "?" || after === "/") return redirectTo;
  }
  return null;
}
