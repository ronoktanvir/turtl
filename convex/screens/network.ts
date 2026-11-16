import { v } from "convex/values";
import { query } from "../functions";
import { accessEnforced, canSeeApp, visibleApps } from "../access";

export type NetworkIdentity = { projectId: string; repo: string; source: "seed" | "built" };

function repository(value: string | undefined): string | null {
  const match = value?.trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+)\/?$/i);
  if (!match) return null;
  const name = match[2].replace(/\.git$/i, "");
  if (!name || [".", ".."].includes(name) || [".", ".."].includes(match[1])) return null;
  return `${match[1]}/${name}`.toLowerCase();
}

export const resolve = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }): Promise<NetworkIdentity | null> => {
    if (!(await canSeeApp(ctx, projectId))) return null;
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId ? await ctx.db.get(appId) : null;
    if (!app || app.isSample) return null;
    const repo = repository(app.repoUrl);
    if (!repo) return null;

    const direct = await ctx.db
      .query("codeNetworks")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .first();
    if (direct && repository(direct.repo) === repo) {
      return { projectId: direct.projectId, repo: direct.repo, source: direct.source };
    }

    // Another project's map of the same repository may stand in, but with accounts on only one of the caller's own.
    const networks = accessEnforced()
      ? (await Promise.all((await visibleApps(ctx)).map((owned) =>
          ctx.db.query("codeNetworks").withIndex("by_project", (q) => q.eq("projectId", owned._id)).order("desc").first(),
        ))).flatMap((row) => (row ? [row] : [])).sort((a, b) => b._creationTime - a._creationTime)
      : await ctx.db.query("codeNetworks").order("desc").collect();
    const seen = new Set<string>();
    const network = networks.find((row) => {
      if (seen.has(row.projectId)) return false;
      seen.add(row.projectId);
      return repository(row.repo) === repo;
    });
    return network ? { projectId: network.projectId, repo: network.repo, source: network.source } : null;
  },
});
