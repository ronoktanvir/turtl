import { v } from "convex/values";
import { decodeJwt, importPKCS8, SignJWT } from "jose";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { open, seal, sealingKey, type SealingKey } from "../secrets/seal";
import type { AppleClient } from "./settings";

// Apple's token endpoints, for one thing: an account made with Sign in with Apple has its Apple token revoked when
// the account is deleted, as Apple requires (developer.apple.com, Sign in with Apple REST API: "Generate and validate
// tokens" and "Revoke tokens").
//
// 1. At sign-in the app sends Apple's one-time authorization code with the identity token (data/account/live.ts).
//    apple.ts hands it to exchangeCode, which trades it at POST /auth/token (grant_type=authorization_code) for a
//    refresh token. The code works once and for five minutes. The answer's id_token must name the same Apple user as
//    the identity token that signed in, so a code taken from someone else is never kept under this account.
// 2. The refresh token is kept in authAppleTokens, sealed the way an owner's secrets are (convex/secrets/seal.ts:
//    AES-GCM under SECRETS_ENCRYPTION_KEY, bound to this purpose and this user), so a copy of the database holds no
//    usable token. Sealing needs an action's randomness, so keepSealed seals before the internal mutation keeps it.
//    Without the key nothing is kept and the log says so: the token is never stored in the clear. Only internal
//    functions read the table, and none returns a row to the app. A row kept before tokens were sealed still holds
//    the token in the clear; it is revoked as it is, and sealKept seals such rows in place.
// 3. When the account is deleted, convex/account opens each kept token (openKept) and revokes it at POST /auth/revoke
//    (token_type_hint=refresh_token). Apple answers 200 for a revoked token and for one already invalid.
//
// Each request carries a client secret: a JWT signed with ES256 by the team's Sign in with Apple key, naming the team
// (iss), the app's bundle id (sub) and Apple (aud), valid for five minutes here (Apple allows up to six months).
// These calls send only Apple's own codes and tokens back to Apple, so they need no AI permission (convex/consent).

const APPLE_AUDIENCE = "https://appleid.apple.com";
/** More sign-ins with Apple than one person makes on their phones; older tokens are dropped past it. */
export const MAX_APPLE_TOKENS = 10;

export async function clientSecret(client: AppleClient, now = Date.now()): Promise<string> {
  const key = await importPKCS8(client.privateKey, "ES256");
  const issuedAt = Math.floor(now / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: client.keyId })
    .setIssuer(client.teamId)
    .setSubject(client.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(key);
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** Trades a sign-in's authorization code for Apple's refresh token. Never throws: a failure is a plain reason. */
export async function exchangeCode(client: AppleClient, code: string, appleUser: string): Promise<{ ok: true; refreshToken: string } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${client.base}/auth/token`, form({
      client_id: client.clientId,
      client_secret: await clientSecret(client),
      code,
      grant_type: "authorization_code",
    }));
    if (!response.ok) return { ok: false, reason: `Apple answered with an error (status ${response.status})` };
    const body = (await response.json()) as { refresh_token?: unknown; id_token?: unknown };
    if (typeof body.refresh_token !== "string" || !body.refresh_token) return { ok: false, reason: "Apple's answer had no refresh token" };
    let subject: unknown;
    try {
      subject = typeof body.id_token === "string" ? decodeJwt(body.id_token).sub : undefined;
    } catch {
      subject = undefined;
    }
    if (subject !== appleUser) return { ok: false, reason: "the authorization code belongs to another Apple account" };
    return { ok: true, refreshToken: body.refresh_token };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "TypeError" ? "Apple could not be reached" : "Apple's answer could not be read" };
  }
}

/** Revokes one refresh token. Apple answers 200 both when it revoked it and when it was already invalid. */
export async function revokeToken(client: AppleClient, refreshToken: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${client.base}/auth/revoke`, form({
      client_id: client.clientId,
      client_secret: await clientSecret(client),
      token: refreshToken,
      token_type_hint: "refresh_token",
    }));
    return response.ok ? { ok: true } : { ok: false, reason: `Apple answered with an error (status ${response.status})` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "TypeError" ? "Apple could not be reached" : "the revocation request could not be made" };
  }
}

// What a sealed token is bound to: this purpose and this user, so a value copied onto another user's row does not open.
const contextOf = (userId: string) => `turtl-secret:apple_refresh_token:${userId}`;
const NO_KEY = "SECRETS_ENCRYPTION_KEY is not set, or is not 32 bytes";

/** Seals Apple's refresh token for a user and keeps it. Without the key it keeps nothing and says so in the log. */
export async function keepSealed(ctx: Pick<ActionCtx, "runMutation">, userId: Id<"users">, refreshToken: string): Promise<boolean> {
  const key = await sealingKey();
  if (!key) {
    console.error(`Sign in with Apple: ${NO_KEY}, so no Apple token was kept to revoke later.`);
    return false;
  }
  const { sealed, keyId } = await seal(refreshToken, contextOf(userId), key);
  await ctx.runMutation(internal.auth.appleTokens.keep, { userId, sealedToken: sealed, keyId });
  return true;
}

export type KeptToken = { id: Id<"authAppleTokens">; refreshToken?: string; sealedToken?: string; keyId?: string };

/** A kept token in the clear, inside the action that sends it to Apple, or why it cannot be. */
export async function openKept(token: KeptToken, account: string, key: SealingKey | null): Promise<{ ok: true; refreshToken: string } | { ok: false; reason: string }> {
  if (token.sealedToken === undefined) return token.refreshToken ? { ok: true, refreshToken: token.refreshToken } : { ok: false, reason: "a kept Apple token is empty" };
  if (!key) return { ok: false, reason: `${NO_KEY}, so turtl cannot open the Apple token to revoke it` };
  if (token.keyId !== key.keyId) return { ok: false, reason: "the Apple token was sealed under an earlier SECRETS_ENCRYPTION_KEY, so turtl cannot open it to revoke it" };
  const refreshToken = await open(token.sealedToken, contextOf(account), key);
  return refreshToken ? { ok: true, refreshToken } : { ok: false, reason: "the kept Apple token does not open for this account" };
}

/** Keeps a sealed refresh token for an account, newest first, at most MAX_APPLE_TOKENS of them. */
export const keep = internalMutation({
  args: { userId: v.id("users"), sealedToken: v.string(), keyId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, sealedToken, keyId }) => {
    const kept = (await ctx.db.query("authAppleTokens").withIndex("userId", (q) => q.eq("userId", userId)).take(MAX_APPLE_TOKENS + 10)).sort((a, b) => b.storedAt - a.storedAt);
    for (const row of kept.slice(MAX_APPLE_TOKENS - 1)) await ctx.db.delete(row._id);
    await ctx.db.insert("authAppleTokens", { userId, sealedToken, keyId, storedAt: Date.now() });
    return null;
  },
});

/** The tokens to revoke for an account, still sealed, for convex/account only. */
export const tokensOf = internalQuery({
  args: { account: v.string() },
  returns: v.array(v.object({ id: v.id("authAppleTokens"), refreshToken: v.optional(v.string()), sealedToken: v.optional(v.string()), keyId: v.optional(v.string()) })),
  handler: async (ctx, { account }) => {
    const userId = ctx.db.normalizeId("users", account);
    if (!userId) return [];
    const rows = await ctx.db.query("authAppleTokens").withIndex("userId", (q) => q.eq("userId", userId as Id<"users">)).take(MAX_APPLE_TOKENS + 10);
    return rows.map((row) => ({ id: row._id, refreshToken: row.refreshToken, sealedToken: row.sealedToken, keyId: row.keyId }));
  },
});

// Rows kept before tokens were sealed. The operator runs `npx convex run auth/appleTokens:sealKept` once after this
// deploys; it seals them in batches and calls itself again until none is left.
const SEAL_BATCH = 50;

export const keptInTheClear = internalQuery({
  args: {},
  returns: v.array(v.object({ id: v.id("authAppleTokens"), userId: v.id("users"), refreshToken: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("authAppleTokens").filter((q) => q.neq(q.field("refreshToken"), undefined)).take(SEAL_BATCH);
    return rows.flatMap((row) => (row.refreshToken ? [{ id: row._id, userId: row.userId, refreshToken: row.refreshToken }] : []));
  },
});

export const replaceKept = internalMutation({
  args: { id: v.id("authAppleTokens"), refreshToken: v.string(), sealedToken: v.string(), keyId: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, refreshToken, sealedToken, keyId }) => {
    const row = await ctx.db.get(id);
    // Only the token that was sealed is replaced; a row deleted or changed meanwhile is left alone.
    if (row?.refreshToken === refreshToken) await ctx.db.patch(id, { refreshToken: undefined, sealedToken, keyId });
    return null;
  },
});

export const sealKept = internalAction({
  args: {},
  returns: v.object({ sealed: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    const key = await sealingKey();
    if (!key) throw new Error(`${NO_KEY}: set it before sealing the kept Apple tokens.`);
    const rows: { id: Id<"authAppleTokens">; userId: Id<"users">; refreshToken: string }[] = await ctx.runQuery(internal.auth.appleTokens.keptInTheClear, {});
    for (const row of rows) {
      const { sealed, keyId } = await seal(row.refreshToken, contextOf(row.userId), key);
      await ctx.runMutation(internal.auth.appleTokens.replaceKept, { id: row.id, refreshToken: row.refreshToken, sealedToken: sealed, keyId });
    }
    const more = rows.length === SEAL_BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.auth.appleTokens.sealKept, {});
    return { sealed: rows.length, more };
  },
});

/** Forgets a token Apple has revoked. */
export const forget = internalMutation({
  args: { id: v.id("authAppleTokens") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id);
    return null;
  },
});
