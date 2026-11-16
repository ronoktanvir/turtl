import { authTables } from "@convex-dev/auth/server";
import { defineTable } from "convex/server";
import { v } from "convex/values";

// Convex Auth's own tables (users, authAccounts, authSessions, authRefreshTokens, authVerificationCodes,
// authVerifiers, authRateLimits), and two of turtl's for Sign in with Apple.
//
// What they hold about a person: an email address, and a name and picture when Apple or GitHub passes one on
// (users); which sign-in methods they use, with Apple's or GitHub's id for them and a Scrypt hash of a password
// (authAccounts); their sessions; and Apple's refresh token for them (authAppleTokens). Passwords and reset codes are
// stored only as hashes. Deleting an account (convex/account) removes every row here that points at it.
export const accountTables = {
  ...authTables,
  // Convex Auth's verifiers, with one more index: deleting an account finds a session's verifiers by it.
  authVerifiers: defineTable(authTables.authVerifiers.validator).index("signature", ["signature"]).index("sessionId", ["sessionId"]),
  /** Nonces of Apple identity tokens already used, kept until the token expires, so each token signs in once. */
  authAppleNonces: defineTable({ nonceHash: v.string(), expiresAt: v.number() }).index("nonceHash", ["nonceHash"]),
  /** Apple's refresh token for an account that signed in with Apple, kept only to revoke it when the account is
   * deleted, as Apple requires. Only convex/auth/appleTokens.ts and convex/account touch this table; no public
   * function may return a row (tests/account-deletion.test.mjs holds that). */
  authAppleTokens: defineTable({ userId: v.id("users"), refreshToken: v.string(), storedAt: v.number() }).index("userId", ["userId"]),
  /** A password reset under way, one row per account: when its code was asked for, and how many times someone tried a
   * code against it. Wrong codes count against the code (it is dropped after a few), never against the address, so
   * nobody can keep the owner's own code from working. Deleted when the reset succeeds; goes with the account. */
  authPasswordResets: defineTable({ accountId: v.id("authAccounts"), requestedAt: v.number(), tries: v.number() }).index("accountId", ["accountId"]),
};
