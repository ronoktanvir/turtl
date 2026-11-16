import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { GenericActionCtx } from "convex/server";
import { ConvexError, v } from "convex/values";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { internal } from "../_generated/api";
import type { DataModel } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { words } from "./rules";
import { appleAudience, appleKeysUrl } from "./settings";

// Sign in with Apple through the iPhone's own sheet (expo-apple-authentication). The app makes a random nonce,
// gives Apple its SHA-256, and sends Apple's identity token and the nonce here. This file checks the token the way
// Apple asks: its signature against Apple's published keys, the issuer, the audience (the app's bundle id), the
// expiry, and that the token's nonce is the hash of the one sent. A nonce works once, so a copied token cannot be
// replayed. Apple's own name and email for the person come in the token; the name only on the first sign-in.

export const APPLE_PROVIDER_ID = "apple";
export const APPLE_ISSUER = "https://appleid.apple.com";
const MIN_NONCE = 32;
const MAX_NONCE = 128;

export type AppleIdentity = { sub: string; email?: string; nonceHash: string; expiresAt: number };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Apple's identity token, checked. Throws one plain refusal for every way it can be wrong. */
export async function verifyAppleIdentityToken(
  token: unknown,
  nonce: unknown,
  options: { keys: JWTVerifyGetKey; audience: string; now?: Date },
): Promise<AppleIdentity> {
  if (typeof token !== "string" || typeof nonce !== "string" || nonce.length < MIN_NONCE || nonce.length > MAX_NONCE) {
    throw new ConvexError(words.appleRefused);
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, options.keys, {
      issuer: APPLE_ISSUER,
      audience: options.audience,
      algorithms: ["RS256"],
      currentDate: options.now,
      clockTolerance: 60,
    }));
  } catch {
    throw new ConvexError(words.appleRefused);
  }
  const nonceHash = await sha256Hex(nonce);
  if (typeof payload.sub !== "string" || !payload.sub || payload.nonce !== nonceHash || typeof payload.exp !== "number") {
    throw new ConvexError(words.appleRefused);
  }
  const email = typeof payload.email === "string" && payload.email ? payload.email.toLowerCase() : undefined;
  return { sub: payload.sub, ...(email ? { email } : {}), nonceHash, expiresAt: payload.exp * 1000 };
}

// Apple rotates its keys; jose fetches them on first use and again when a token names a key it has not seen.
let keySet: { url: string; keys: JWTVerifyGetKey } | undefined;
function appleKeys(): JWTVerifyGetKey {
  const url = appleKeysUrl();
  if (keySet?.url !== url) keySet = { url, keys: createRemoteJWKSet(new URL(url)) };
  return keySet.keys;
}

async function findAppleAccount(ctx: GenericActionCtx<DataModel>, sub: string) {
  try {
    return (await retrieveAccount(ctx, { provider: APPLE_PROVIDER_ID, account: { id: sub } })).account;
  } catch (error) {
    if (error instanceof Error && error.message === "InvalidAccountId") return null;
    throw error;
  }
}

export function apple() {
  return ConvexCredentials<DataModel>({
    id: APPLE_PROVIDER_ID,
    authorize: async (params, ctx) => {
      const identity = await verifyAppleIdentityToken(params.identityToken, params.nonce, { keys: appleKeys(), audience: appleAudience() });
      const fresh: boolean = await ctx.runMutation(internal.auth.apple.spendNonce, { nonceHash: identity.nonceHash, expiresAt: identity.expiresAt });
      if (!fresh) throw new ConvexError(words.appleRefused);
      const existing = await findAppleAccount(ctx, identity.sub);
      if (existing) return { userId: existing.userId };
      // Apple passes the name to the app once, on the first sign-in, and not inside the token. It is display text only.
      const name = typeof params.name === "string" ? params.name.trim().slice(0, 100) : "";
      const { user } = await createAccount(ctx, {
        provider: APPLE_PROVIDER_ID,
        account: { id: identity.sub },
        profile: { ...(identity.email ? { email: identity.email } : {}), ...(name ? { name } : {}) },
        shouldLinkViaEmail: false,
      });
      return { userId: user._id };
    },
  });
}

/** Records a nonce as used. False when it already was, which means the token is being replayed. */
export const spendNonce = internalMutation({
  args: { nonceHash: v.string(), expiresAt: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { nonceHash, expiresAt }) => {
    const seen = await ctx.db.query("authAppleNonces").withIndex("nonceHash", (q) => q.eq("nonceHash", nonceHash)).first();
    if (seen) return false;
    const id = await ctx.db.insert("authAppleNonces", { nonceHash, expiresAt });
    // Once the token has expired it cannot be replayed anyway, so the record can go.
    await ctx.scheduler.runAt(Math.max(Date.now(), expiresAt) + 60_000, internal.auth.apple.forgetNonce, { id });
    return true;
  },
});

export const forgetNonce = internalMutation({
  args: { id: v.id("authAppleNonces") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id);
    return null;
  },
});
