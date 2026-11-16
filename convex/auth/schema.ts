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
   * deleted, as Apple requires. Sealed (sealedToken, under the key keyId names; convex/auth/appleTokens.ts); a row
   * kept before tokens were sealed holds refreshToken in the clear until sealKept seals it. Only
   * convex/auth/appleTokens.ts and convex/account touch this table; no public function may return a row
   * (tests/account-deletion.test.mjs holds that). */
  authAppleTokens: defineTable({ userId: v.id("users"), refreshToken: v.optional(v.string()), sealedToken: v.optional(v.string()), keyId: v.optional(v.string()), storedAt: v.number() }).index("userId", ["userId"]),
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
    /** A confirmed address's first reset email of the day, sent outside the day's pool (convex/auth/codes.ts). */
    firstOfDay: v.optional(v.boolean()),
  })
    .index("by_address_purpose_and_sent", ["addressHash", "purpose", "sentAt"])
    .index("by_sent", ["sentAt"]),
  /** A password account that has not yet confirmed its email address, from sign-up until it does
   * (convex/auth/confirmation.ts). While the row exists the account reaches nothing but the "check your email" screen.
   * Deleted when the address is confirmed; an account still here after UNCONFIRMED_DAYS is deleted. */
  authUnconfirmed: defineTable({ account: v.string(), since: v.number() }).index("by_account", ["account"]).index("by_since", ["since"]),
  /** Running counts behind the limits per email domain and on the day's emails (convex/auth/counts.ts): sign-ups and
   * confirmations per domain per hour and per day, and emails per day, for the whole deployment ("" as the key) or per
   * domain. `key` is a SHA-256 hash of the domain, never the domain; `window` is the UTC hour or day. They name no
   * account and no address; the hourly sweep deletes every window before today. */
  authCounts: defineTable({
    name: v.union(
      v.literal("domain_signups_hour"),
      v.literal("domain_signups_day"),
      v.literal("domain_confirmations_hour"),
      v.literal("domain_confirmations_day"),
      v.literal("emails_day"),
      v.literal("signup_emails_day"),
      v.literal("domain_signup_emails_day"),
      v.literal("domain_reset_emails_day"),
      v.literal("first_resets_day"),
    ),
    key: v.string(),
    window: v.string(),
    value: v.number(),
  })
    .index("by_name_key_and_window", ["name", "key", "window"])
    .index("by_window", ["window"]),
};
