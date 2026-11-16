// Rules and words for sign-in that the backend enforces and the app repeats before it asks. Pure: no Convex imports,
// so the app can load this file too.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** What the owner reads when something about signing in goes wrong. One place, so the app and backend agree. */
export const words = {
  wrongPassword: "That email and password don't match. Check them and try again, or reset your password.",
  accountExists: "There's already an account for this email.",
  weakPassword: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters that isn't easy to guess.`,
  passwordTooLong: `Choose a password of at most ${MAX_PASSWORD_LENGTH} characters.`,
  passwordIsEmail: "Choose a password that isn't your email address.",
  badEmail: "Enter your email address, like name@example.com.",
  tooManyTries: "Too many wrong passwords for this account. Wait an hour and try again, or reset your password.",
  wrongCode: "That code didn't work. Check the latest email from turtl, or ask for a new code.",
  resetOff: "Password reset by email isn't available yet. Contact support and we'll help you back in.",
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
