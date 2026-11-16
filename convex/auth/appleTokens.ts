import { v } from "convex/values";
import { decodeJwt, importPKCS8, SignJWT } from "jose";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import type { AppleClient } from "./settings";

// Apple's token endpoints, for one thing: an account made with Sign in with Apple has its Apple token revoked when
// the account is deleted, as Apple requires (developer.apple.com, Sign in with Apple REST API: "Generate and validate
// tokens" and "Revoke tokens").
//
// 1. At sign-in the app sends Apple's one-time authorization code with the identity token (data/account/live.ts).
//    apple.ts hands it to exchangeCode, which trades it at POST /auth/token (grant_type=authorization_code) for a
//    refresh token. The code works once and for five minutes. The answer's id_token must name the same Apple user as
//    the identity token that signed in, so a code taken from someone else is never kept under this account.
// 2. The refresh token is kept in authAppleTokens. Only internal functions read that table, and none returns a row to
//    the app.
// 3. When the account is deleted, convex/account revokes each kept token at POST /auth/revoke
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

/** Keeps a refresh token for an account, newest first, at most MAX_APPLE_TOKENS of them. */
export const keep = internalMutation({
  args: { userId: v.id("users"), refreshToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, refreshToken }) => {
    const kept = (await ctx.db.query("authAppleTokens").withIndex("userId", (q) => q.eq("userId", userId)).take(MAX_APPLE_TOKENS + 10)).sort((a, b) => b.storedAt - a.storedAt);
    if (kept.some((row) => row.refreshToken === refreshToken)) return null;
    for (const row of kept.slice(MAX_APPLE_TOKENS - 1)) await ctx.db.delete(row._id);
    await ctx.db.insert("authAppleTokens", { userId, refreshToken, storedAt: Date.now() });
    return null;
  },
});

/** The tokens to revoke for an account, for convex/account only. */
export const tokensOf = internalQuery({
  args: { account: v.string() },
  returns: v.array(v.object({ id: v.id("authAppleTokens"), refreshToken: v.string() })),
  handler: async (ctx, { account }) => {
    const userId = ctx.db.normalizeId("users", account);
    if (!userId) return [];
    const rows = await ctx.db.query("authAppleTokens").withIndex("userId", (q) => q.eq("userId", userId as Id<"users">)).take(MAX_APPLE_TOKENS + 10);
    return rows.map((row) => ({ id: row._id, refreshToken: row.refreshToken }));
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
