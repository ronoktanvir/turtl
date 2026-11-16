import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { standInOnly } from "../demoSettings";

declare const process: { env: Record<string, string | undefined> };

// Every environment variable sign-in depends on, read in one place. Convex Auth reads some of these itself, inside
// the library; they are read here by name too, so `check` can say which are missing and release/backend-env.mjs
// can see them. Values never leave this file: callers get booleans and names.

/** Bundle id Apple puts in the audience of a Sign in with Apple identity token. */
export const DEFAULT_APPLE_BUNDLE_ID = "com.turtl.oncall";

/** What accounts mode cannot work without. Convex Auth reads all three. */
const REQUIRED = ["JWT_PRIVATE_KEY", "JWKS", "SITE_URL"] as const;
/** What GitHub sign-in cannot work without. Convex Auth reads both through Auth.js. */
const GITHUB = ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"] as const;
/** Knobs Convex Auth reads when they are set. Listed so the release table knows them; none is required. */
const LIBRARY_KNOBS = ["AUTH_LOG_LEVEL", "AUTH_LOG_SECRETS", "AUTH_SESSION_TOTAL_DURATION_MS", "AUTH_SESSION_INACTIVE_DURATION_MS", "CUSTOM_AUTH_SITE_URL"] as const;

type Name = (typeof REQUIRED)[number] | (typeof GITHUB)[number] | (typeof LIBRARY_KNOBS)[number];
const isSet = (name: Name) => Boolean(process.env[name]);

/** A stand-in server for GitHub, Apple's keys and turtl's email, used only by tests. Never set in production: with
 * accounts on it is honoured only on a local backend, since that server would decide who is signed in. */
export function standInUrl(): string | undefined {
  const url = standInOnly(process.env.AUTH_STAND_IN_URL)?.replace(/\/$/, "");
  return url || undefined;
}

export function appleAudience(): string {
  return process.env.AUTH_APPLE_BUNDLE_ID || DEFAULT_APPLE_BUNDLE_ID;
}

/** Where Apple publishes the keys that sign its identity tokens. */
export function appleKeysUrl(): string {
  const standIn = standInUrl();
  return standIn ? `${standIn}/apple/auth/keys` : "https://appleid.apple.com/auth/keys";
}

/** Where Apple's token endpoints live (/auth/token, /auth/revoke). */
export function appleAuthBase(): string {
  const standIn = standInUrl();
  return standIn ? `${standIn}/apple` : "https://appleid.apple.com";
}

export type AppleClient = { clientId: string; teamId: string; keyId: string; privateKey: string; base: string };

/** What talking to Apple's token endpoints needs: the Apple Developer team, and the id and contents of a Sign in with
 * Apple key (a .p8 file) made in that account. turtl uses it to keep a person's Apple refresh token at sign-in and to
 * revoke it when they delete their account. Null until all three are set. */
export function appleClient(): AppleClient | null {
  const teamId = process.env.AUTH_APPLE_TEAM_ID?.trim();
  const keyId = process.env.AUTH_APPLE_KEY_ID?.trim();
  const privateKey = process.env.AUTH_APPLE_PRIVATE_KEY;
  if (!teamId || !keyId || !privateKey) return null;
  return { clientId: appleAudience(), teamId, keyId, privateKey, base: appleAuthBase() };
}

/** turtl's email (a password reset, and confirming a new password account's address) goes out only when both the key
 * and a sender are set. With accounts on, password sign-up needs it too (convex/auth/password.ts). */
export function emailService(): { key: string; from: string; endpoint: string } | null {
  const key = process.env.AUTH_RESEND_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!key || !from) return null;
  const standIn = standInUrl();
  return { key, from, endpoint: standIn ? `${standIn}/email/emails` : "https://api.resend.com/emails" };
}

export function githubConfigured(): boolean {
  return GITHUB.every(isSet);
}

/** Names, never values, of what sign-in still needs on this deployment. */
export function missingSettings(): string[] {
  return [...REQUIRED, ...GITHUB].filter((name) => !isSet(name));
}

/** For the runbook: `npx convex run auth/settings:check` says what sign-in still needs, without printing a value. */
export const check = internalQuery({
  args: {},
  returns: v.object({
    missing: v.array(v.string()),
    passwordReset: v.boolean(),
    appleAudience: v.string(),
    appleRevocation: v.boolean(),
    standIn: v.boolean(),
    knobs: v.array(v.string()),
  }),
  handler: async () => ({
    missing: missingSettings(),
    passwordReset: emailService() !== null,
    appleAudience: appleAudience(),
    appleRevocation: appleClient() !== null,
    standIn: standInUrl() !== undefined,
    knobs: LIBRARY_KNOBS.filter(isSet),
  }),
});
