import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { vLeftOut } from "./schema";
import { clearToken } from "./tokens";

// Which turtl account may use which installation of turtl's GitHub App. A link is written by the Connect GitHub
// flow (connect.ts) and read by repositoryAccess when accounts are on (AUTH_REQUIRED=true).
//
// With accounts on, a link in someone else's GitHub account (an organization, or another person's account) lists only
// the repositories its GitHub user can change there, because turtl's app can change every repository it covers.
// GitHub is asked again before turtl changes anything (permission.ts), and on refresh.

/** More installations than one account will connect; it bounds every read of an account's links. */
export const MAX_LINKS = 20;
/** The repositories one link in someone else's account may hold. turtl asks GitHub about each of them on refresh, so
 * the list stays short; an account has at most 10 projects. */
export const MAX_LINK_REPOSITORIES = 100;
/** The left-out repositories a link remembers, to explain them. */
export const MAX_LEFT_OUT = 50;
const SCAN = 50;

/** Why a repository GitHub listed is not in the person's link, in the words the app shows under the picker. */
export const LEFT_OUT = {
  read_only: "You can read this repository but not change it, so turtl cannot open pull requests on it.",
  lost: "You can no longer change this repository on GitHub, so turtl stopped using it for you.",
  too_many: `turtl uses at most ${MAX_LINK_REPOSITORIES} repositories from one organization, so it left this one out.`,
} as const;

export type LeftOut = { fullName: string; why: keyof typeof LEFT_OUT };

/** Joins two left-out lists, the newer entry winning for a repository, keeping the newest MAX_LEFT_OUT. */
export function mergeLeftOut(earlier: LeftOut[], newer: LeftOut[]): LeftOut[] {
  const byName = new Map<string, LeftOut>();
  for (const entry of [...earlier, ...newer]) {
    byName.delete(entry.fullName.toLowerCase());
    byName.set(entry.fullName.toLowerCase(), entry);
  }
  return [...byName.values()].slice(-MAX_LEFT_OUT);
}

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

// Every installation the account uses. An inactive link (an attempt nobody finished) does not count: it may hold
// someone else's installation, confirmed by GitHub for whoever opened the link, and it is only ever deleted.
export const installationsOf = internalQuery({
  args: { account: v.string() },
  returns: v.array(v.number()),
  handler: async (ctx, { account }) => [...new Set((await linksOf(ctx, account)).filter((link) => link.active).map((link) => link.installationId))],
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

// Removes the account's links to one installation, and the installation's cached token, so nothing turtl holds was
// minted while this account was linked. The installation itself stays, for whoever may still use it.
export const unlink = internalMutation({
  args: { account: v.string(), installationId: v.number() },
  returns: v.null(),
  handler: async (ctx, { account, installationId }) => {
    for (const link of await linksOf(ctx, account, installationId)) await ctx.db.delete(link._id);
    await clearToken(ctx, installationId);
    return null;
  },
});

const vLinkView = v.object({
  githubUserId: v.number(),
  githubLogin: v.string(),
  // The installation is on this GitHub user's own account: every repository it covers is theirs.
  own: v.boolean(),
  repositories: v.array(v.string()),
  checkedAt: v.optional(v.number()),
});

/** The account's link to one installation (the newest, if there were ever two), for the checks in permission.ts. */
export const linkFor = internalQuery({
  args: { account: v.string(), installationId: v.number() },
  returns: v.union(vLinkView, v.null()),
  handler: async (ctx, { account, installationId }) => {
    const [link] = (await linksOf(ctx, account, installationId)).filter((candidate) => candidate.active).sort((a, b) => b.confirmedAt - a.confirmedAt);
    if (!link) return null;
    return {
      githubUserId: link.githubUserId,
      githubLogin: link.githubLogin,
      own: link.repositories === undefined,
      repositories: link.repositories ?? [],
      ...(link.checkedAt !== undefined && { checkedAt: link.checkedAt }),
    };
  },
});

/**
 * What GitHub just said about a link's GitHub user: the repositories in `drop` leave the link and are remembered with
 * why, so the app can say so. With checkedAt, GitHub confirmed every repository left in the link at that time. Only
 * links of the same GitHub user change, so a link that was replaced meanwhile by someone else's is left alone.
 */
export const recheck = internalMutation({
  args: {
    account: v.string(),
    installationId: v.number(),
    githubUserId: v.number(),
    drop: v.array(vLeftOut),
    checkedAt: v.optional(v.number()),
    githubLogin: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { account, installationId, githubUserId, drop, checkedAt, githubLogin }) => {
    const dropped = new Set(drop.map((entry) => entry.fullName.toLowerCase()));
    for (const link of await linksOf(ctx, account, installationId)) {
      if (!link.active || link.githubUserId !== githubUserId || link.repositories === undefined) continue;
      await ctx.db.patch(link._id, {
        repositories: link.repositories.filter((name) => !dropped.has(name)),
        ...(drop.length > 0 && { leftOut: mergeLeftOut(link.leftOut ?? [], drop) }),
        ...(checkedAt !== undefined && { checkedAt }),
        ...(githubLogin && { githubLogin }),
      });
    }
    return null;
  },
});

/** The repositories GitHub listed for the account that turtl left out, with why, for the picker. */
export const leftOutOf = internalQuery({
  args: { account: v.string() },
  returns: v.array(v.object({ fullName: v.string(), message: v.string() })),
  handler: async (ctx, { account }) => {
    const links = await activeLinks(ctx, account);
    const allowed = (name: string) => links.some((link) => linkAllows(link, name));
    // Oldest link first, so a newer link's reason wins.
    const entries = mergeLeftOut([], [...links].reverse().flatMap((link) => link.leftOut ?? [])).filter((entry) => !allowed(entry.fullName));
    return entries
      .map((entry) => ({ fullName: entry.fullName, message: LEFT_OUT[entry.why] }))
      .sort((a, b) => a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()));
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
