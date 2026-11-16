import { authTables } from "@convex-dev/auth/server";
import { defineTable } from "convex/server";
import { v } from "convex/values";

// Convex Auth's own tables (users, authAccounts, authSessions, authRefreshTokens, authVerificationCodes,
// authVerifiers, authRateLimits), two of turtl's for Sign in with Apple, and two for the codes turtl emails.
//
// What they hold about a person: an email address, and a name and picture when Apple or GitHub passes one on
// (users); which sign-in methods they use, with Apple's or GitHub's id for them and a Scrypt hash of a password
// (authAccounts); their sessions; Apple's refresh token for them (authAppleTokens); and whether a password account
// has confirmed its address yet (authUnconfirmed). Passwords and emailed codes are stored only as hashes, and emailed
// codes under a hash of the address. Deleting an account (convex/account) removes every row here that points at it;
// authEmailCodes points at an address, not an account, and is gone a day after each email.
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
  /** Every code turtl has emailed in the last day, one row per email: whose address (a SHA-256 hash of it, never the
   * address), what for, the code's hash, when it was sent and when it stops working, and when it was used. Rows are
   * what limits emails to an address (convex/auth/codes.ts), so they are tied to the address, not to an account, and
   * outlive a deleted account; the hourly sweep deletes each one a day after it was sent. */
  authEmailCodes: defineTable({
    addressHash: v.string(),
    purpose: v.union(v.literal("reset"), v.literal("confirm")),
    codeHash: v.string(),
    sentAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_address_purpose_and_sent", ["addressHash", "purpose", "sentAt"])
    .index("by_sent", ["sentAt"]),
  /** A password account that has not yet confirmed its email address, from sign-up until it does
   * (convex/auth/confirmation.ts). While the row exists the account reaches nothing but the "check your email" screen.
   * Deleted when the address is confirmed; an account still here after UNCONFIRMED_DAYS is deleted. */
  authUnconfirmed: defineTable({ account: v.string(), since: v.number() }).index("by_account", ["account"]).index("by_since", ["since"]),
};
