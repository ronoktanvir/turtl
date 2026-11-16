import { authTables } from "@convex-dev/auth/server";
import { defineTable } from "convex/server";
import { v } from "convex/values";

// Convex Auth's own tables (users, authAccounts, authSessions, authRefreshTokens, authVerificationCodes,
// authVerifiers, authRateLimits), and one of turtl's for Sign in with Apple.
//
// What they hold about a person: an email address, and a name and picture when Apple or GitHub passes one on
// (users); which sign-in methods they use, with Apple's or GitHub's id for them and a Scrypt hash of a password
// (authAccounts); and their sessions. Passwords and reset codes are stored only as hashes.
export const accountTables = {
  ...authTables,
  /** Nonces of Apple identity tokens already used, kept until the token expires, so each token signs in once. */
  authAppleNonces: defineTable({ nonceHash: v.string(), expiresAt: v.number() }).index("nonceHash", ["nonceHash"]),
};
