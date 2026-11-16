import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { listRepositories, readInstallation, REPOSITORIES_PER_PAGE } from "./api";
import { appConfig } from "./config";
import { signAppJwt, UNREADABLE_KEY } from "./jwt";
import type { Repository } from "./shapes";
import { installationToken } from "./tokens";

const MAX_PAGES = 100;

export type RefreshResult = { ok: true; repositories: Repository[] } | { ok: false; message: string };

// Reads one installation and every repository it covers from GitHub, makes turtl's records match, and returns
// the repositories. This is the fresh list for the repository picker and the repair for a missed webhook.
// Run: npx convex run github/sync:refresh '{"installationId":123}'
export const refresh = internalAction({
  args: { installationId: v.number() },
  handler: async (ctx, { installationId }): Promise<RefreshResult> => {
    const app = appConfig();
    if (app.state !== "ready") return { ok: false, message: "turtl's GitHub App is not configured on this deployment." };
    const jwt = await signAppJwt(app.appId, app.privateKey);
    if (!jwt) return { ok: false, message: UNREADABLE_KEY };
    const read = await readInstallation(jwt, installationId);
    if (!read.ok) {
      if (read.status === 404) await ctx.runMutation(internal.github.installations.markDeleted, { installationId });
      return { ok: false, message: read.message };
    }
    const { suspended, ...installation } = read.body;
    const startedAt = Date.now();
    await ctx.runMutation(internal.github.installations.record, {
      installation,
      status: suspended ? "suspended" : "active",
      repositories: [],
      seenAt: startedAt,
    });
    if (suspended) return { ok: false, message: `${installation.accountLogin} has suspended turtl's GitHub App.` };
    const token = await installationToken(ctx, jwt, installationId);
    if (!token.ok) return { ok: false, message: token.message };
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        return { ok: false, message: `The installation covers more than ${MAX_PAGES * REPOSITORIES_PER_PAGE} repositories; turtl did not read them all.` };
      }
      const listed = await listRepositories(token.body, page);
      if (!listed.ok) return { ok: false, message: listed.message };
      await ctx.runMutation(internal.github.installations.record, { installation, status: "active", repositories: listed.body, seenAt: startedAt });
      if (listed.body.length < REPOSITORIES_PER_PAGE) break;
    }
    await ctx.runMutation(internal.github.installations.dropRepositories, { installationId, before: startedAt });
    return { ok: true, repositories: await ctx.runQuery(internal.github.installations.repositories, { installationId }) };
  },
});
