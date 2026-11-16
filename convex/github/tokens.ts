import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { mintInstallationToken, type GithubReply } from "./api";

// A cached token is reused until five minutes before GitHub expires it (GitHub issues them for one hour).
const REFRESH_MARGIN_MS = 5 * 60_000;

const tokenRow = (ctx: QueryCtx, installationId: number) =>
  ctx.db
    .query("githubInstallationTokens")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .unique();

export const cached = internalQuery({
  args: { installationId: v.number() },
  handler: async (ctx, { installationId }) => {
    const row = await tokenRow(ctx, installationId);
    return row && { token: row.token, expiresAt: row.expiresAt };
  },
});

export const store = internalMutation({
  args: { installationId: v.number(), token: v.string(), expiresAt: v.number() },
  handler: async (ctx, { installationId, token, expiresAt }) => {
    const row = await tokenRow(ctx, installationId);
    if (row) await ctx.db.patch(row._id, { token, expiresAt });
    else await ctx.db.insert("githubInstallationTokens", { installationId, token, expiresAt });
  },
});

export async function clearToken(ctx: MutationCtx, installationId: number) {
  const row = await tokenRow(ctx, installationId);
  if (row) await ctx.db.delete(row._id);
}

// The installation's token: the cached one while it has more than five minutes left, otherwise a new one
// minted with the app's JWT. When GitHub no longer knows the installation, turtl records it as deleted.
export async function installationToken(ctx: ActionCtx, jwt: string, installationId: number): Promise<GithubReply<string>> {
  const kept: { token: string; expiresAt: number } | null = await ctx.runQuery(internal.github.tokens.cached, { installationId });
  if (kept && kept.expiresAt - Date.now() > REFRESH_MARGIN_MS) return { ok: true, body: kept.token };
  const minted = await mintInstallationToken(jwt, installationId);
  if (!minted.ok) {
    if (minted.status === 404) await ctx.runMutation(internal.github.installations.markDeleted, { installationId });
    return minted;
  }
  await ctx.runMutation(internal.github.tokens.store, { installationId, ...minted.body });
  return { ok: true, body: minted.body.token };
}
