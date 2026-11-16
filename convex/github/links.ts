import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";

// Which turtl account may use which installation of turtl's GitHub App. A link is written by the Connect GitHub
// flow (connect.ts) and read by repositoryAccess when accounts are on (AUTH_REQUIRED=true).

/** More installations than one account will connect; it bounds every read of an account's links. */
export const MAX_LINKS = 20;
const SCAN = 50;

const linksOf = (ctx: QueryCtx, account: string, installationId?: number) =>
  ctx.db
    .query("githubInstallationLinks")
    .withIndex("by_account_and_installation", (q) => (installationId === undefined ? q.eq("account", account) : q.eq("account", account).eq("installationId", installationId)))
    .take(SCAN);

/** The account's links that are in use, newest confirmation first. */
export async function activeLinks(ctx: QueryCtx, account: string): Promise<Doc<"githubInstallationLinks">[]> {
  return (await linksOf(ctx, account)).filter((link) => link.active).sort((a, b) => b.confirmedAt - a.confirmedAt).slice(0, MAX_LINKS);
}

/** Whether a link lets its account reach a repository the installation covers. */
export const linkAllows = (link: Pick<Doc<"githubInstallationLinks">, "repositories">, repo: string) =>
  link.repositories === undefined || link.repositories.includes(repo.toLowerCase());

async function allowed(ctx: QueryCtx, account: string, installationId: number, repo: string) {
  return (await linksOf(ctx, account, installationId)).some((link) => link.active && linkAllows(link, repo));
}

// The project's owner, by the rule in convex/access.ts: the account in apps.ownerId. Null when the project or case
// does not exist or has no owner.
export const ownerOf = internalQuery({
  args: { appId: v.optional(v.string()), caseId: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { appId, caseId }) => {
    let appKey = appId === undefined ? null : ctx.db.normalizeId("apps", appId);
    if (caseId !== undefined) {
      const caseKey = ctx.db.normalizeId("cases", caseId);
      appKey = (caseKey ? await ctx.db.get(caseKey) : null)?.appId ?? null;
    }
    const app = appKey ? await ctx.db.get(appKey) : null;
    return app?.ownerId ?? null;
  },
});

// The active installation that covers a repository and is linked to the account for it, by turtl's records, or null.
export const coveringForAccount = internalQuery({
  args: { account: v.string(), repo: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { account, repo }) => {
    const rows = (
      await ctx.db
        .query("githubInstallationRepositories")
        .withIndex("by_full_name", (q) => q.eq("fullNameLower", repo.toLowerCase()))
        .take(SCAN)
    ).sort((a, b) => b.seenAt - a.seenAt);
    for (const row of rows) {
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation", (q) => q.eq("installationId", row.installationId))
        .unique();
      if (installation?.status === "active" && (await allowed(ctx, account, row.installationId, repo))) return row.installationId;
    }
    return null;
  },
});

export const allows = internalQuery({
  args: { account: v.string(), installationId: v.number(), repo: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { account, installationId, repo }) => await allowed(ctx, account, installationId, repo),
});

// Every installation the account has a link to, in use or waiting for the app to finish an attempt.
export const installationsOf = internalQuery({
  args: { account: v.string() },
  returns: v.array(v.number()),
  handler: async (ctx, { account }) => [...new Set((await linksOf(ctx, account)).map((link) => link.installationId))],
});

// How many other accounts use an installation. When none does, disconnecting uninstalls it.
export const otherAccounts = internalQuery({
  args: { installationId: v.number(), account: v.string() },
  returns: v.number(),
  handler: async (ctx, { installationId, account }) => {
    const links = await ctx.db
      .query("githubInstallationLinks")
      .withIndex("by_installation", (q) => q.eq("installationId", installationId))
      .take(SCAN);
    return new Set(links.filter((link) => link.active && link.account !== account).map((link) => link.account)).size;
  },
});

// Removes the account's links to one installation. The installation itself stays for the accounts still using it.
export const unlink = internalMutation({
  args: { account: v.string(), installationId: v.number() },
  returns: v.null(),
  handler: async (ctx, { account, installationId }) => {
    for (const link of await linksOf(ctx, account, installationId)) await ctx.db.delete(link._id);
    return null;
  },
});

// Removes every link to an installation, for an installation GitHub no longer has.
export async function dropLinks(ctx: MutationCtx, installationId: number) {
  const links = await ctx.db
    .query("githubInstallationLinks")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .take(500);
  for (const link of links) await ctx.db.delete(link._id);
}
