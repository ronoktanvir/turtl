import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { action, mutation, query } from "../functions";
import { accessEnforced, currentAccount, requireAccount } from "../access";
import { requireOwnerPasscode } from "../ownerPasscode";
import { deleteInstallation } from "./api";
import { appConfig, authorizeUrl, connectConfig, githubWebUrl, installationSettingsUrl, returnAddress } from "./config";
import { signAppJwt, UNREADABLE_KEY } from "./jwt";
import { activeLinks, linkAllows, mergeLeftOut } from "./links";
import { recheckIfDue } from "./permission";
import { vLeftOut } from "./schema";
import { randomSecret, sha256 } from "./secrets";
import { refreshInstallation } from "./sync";

// Connect GitHub: the public functions the app calls, and the records behind them.
//
// 1. begin (the app, signed in): stores an attempt for the caller and returns GitHub's install page, carrying a
//    random state. GitHub sends the person to /github/setup with that state after they install or change the app.
// 2. /github/setup and /github/callback (http.ts): the installation id GitHub puts in the address is never read.
//    The person authorizes the app, the code becomes a user token, and GitHub lists the installations that token can
//    reach and, in each, the repositories this person can reach. turtl writes inactive links, revokes the token, and
//    sends the person back to the app with a one-time ticket.
// 3. finish (the app, signed in): the ticket works only for the account that started the attempt, so a person who
//    is sent someone else's install link cannot connect their repositories to that person's turtl.
// 4. disconnect: uninstalls the app at GitHub from an installation the person may remove (with accounts on, only one on
//    their own GitHub account) that no other account uses, and deletes the records. From any other installation it
//    removes only the person's link, and says who can remove the app.
//
// With accounts on, an installation in someone else's account links only the repositories GitHub says the person can
// change (push, maintain or admin), and GitHub is asked again before turtl changes anything there (permission.ts).

const ATTEMPT_MS = 15 * 60_000;
const TICKET_MS = 10 * 60_000;
const PICKER_LIMIT = 500;
const SCAN = 50;

export const EXPIRED = "This GitHub connection has expired or was started on another sign-in. Tap Connect GitHub again.";
export const NOT_SET_UP = "Connecting GitHub is not set up on this turtl backend yet.";
const PASSCODE_FIRST = "Set an owner passcode in project settings before disconnecting GitHub.";

const vConnection = v.object({
  installationId: v.number(),
  accountLogin: v.string(),
  githubLogin: v.string(),
  status: v.union(v.literal("active"), v.literal("suspended")),
  // "all": the installation is on the person's own account. "chosen": the repositories they could reach when they connected.
  scope: v.union(v.literal("all"), v.literal("chosen")),
  settingsUrl: v.string(),
});
const vPickable = v.object({ fullName: v.string(), private: v.optional(v.boolean()), installationId: v.number(), accountLogin: v.string() });
const vDisconnected = v.object({
  ok: v.boolean(),
  disconnected: v.number(),
  failed: v.array(v.object({ installationId: v.number(), message: v.string() })),
  // Installations turtl stopped using for the caller but left installed on GitHub, because it is not theirs to remove
  // (an organization's, or someone else's account) or another turtl account still uses it, with a sentence that says
  // so and who can remove it.
  stillInstalled: v.array(v.object({ installationId: v.number(), accountLogin: v.string(), message: v.string() })),
});

/** Who can remove turtl's app from an installation turtl leaves installed, in plain words. */
export const STILL_INSTALLED = (accountLogin: string, accountType: string | undefined, ownAccount: boolean) =>
  ownAccount
    ? `turtl stopped using ${accountLogin} for you. Its app stays installed there because another turtl account still uses it; you can remove it in your settings on GitHub.`
    : accountType === "Organization"
      ? `turtl stopped using ${accountLogin} for you, but its app is still installed on ${accountLogin}. Only an owner of ${accountLogin} can remove it, in ${accountLogin}'s settings on GitHub.`
      : `turtl stopped using ${accountLogin}'s repositories for you, but its app is still installed on ${accountLogin}. Only ${accountLogin} can remove it, in their settings on GitHub.`;

const installationRow = (ctx: QueryCtx, installationId: number) =>
  ctx.db
    .query("githubInstallations")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .unique();

const attemptsOf = (ctx: QueryCtx, account: string) =>
  ctx.db
    .query("githubConnectAttempts")
    .withIndex("by_account", (q) => q.eq("account", account))
    .take(SCAN);

const attemptLinks = (ctx: QueryCtx, attemptId: Id<"githubConnectAttempts">) =>
  ctx.db
    .query("githubInstallationLinks")
    .withIndex("by_attempt", (q) => q.eq("attemptId", attemptId))
    .take(SCAN);

async function forget(ctx: MutationCtx, account: string) {
  for (const attempt of await attemptsOf(ctx, account)) {
    for (const link of await attemptLinks(ctx, attempt._id)) if (!link.active) await ctx.db.delete(link._id);
    await ctx.db.delete(attempt._id);
  }
}

// ---------------------------------------------------------------------------------------------- for the app

// What the app needs to draw Connect GitHub: whether it is set up, whether accounts are on, and the caller's connections.
export const status = query({
  args: {},
  returns: v.object({ configured: v.boolean(), accounts: v.boolean(), signedIn: v.boolean(), connections: v.array(vConnection) }),
  handler: async (ctx) => {
    const configured = connectConfig().ok;
    const account = await currentAccount(ctx);
    const base = { configured, accounts: accessEnforced(), signedIn: account !== null };
    if (!configured || !account) return { ...base, connections: [] };
    const connections = [];
    for (const link of await activeLinks(ctx, account)) {
      const installation = await installationRow(ctx, link.installationId);
      if (!installation || installation.status === "deleted") continue;
      connections.push({
        installationId: link.installationId,
        accountLogin: installation.accountLogin,
        githubLogin: link.githubLogin,
        status: installation.status,
        scope: link.repositories === undefined ? ("all" as const) : ("chosen" as const),
        settingsUrl: installationSettingsUrl(link.installationId, installation.accountLogin, installation.accountType),
      });
    }
    return { ...base, connections };
  },
});

// The repositories the caller connected, by name, for the picker. Up to 500 per installation.
export const repositories = query({
  args: {},
  returns: v.array(vPickable),
  handler: async (ctx) => {
    const account = await currentAccount(ctx);
    if (!account || !connectConfig().ok) return [];
    const picked = new Map<string, { fullName: string; private?: boolean; installationId: number; accountLogin: string }>();
    for (const link of await activeLinks(ctx, account)) {
      const installation = await installationRow(ctx, link.installationId);
      if (installation?.status !== "active") continue;
      const rows = await ctx.db
        .query("githubInstallationRepositories")
        .withIndex("by_installation_and_seen", (q) => q.eq("installationId", link.installationId))
        .take(PICKER_LIMIT);
      for (const row of rows) {
        if (!linkAllows(link, row.fullName) || picked.has(row.fullNameLower)) continue;
        picked.set(row.fullNameLower, {
          fullName: row.fullName,
          ...(row.private !== undefined && { private: row.private }),
          installationId: link.installationId,
          accountLogin: installation.accountLogin,
        });
      }
    }
    return [...picked.values()].sort((a, b) => a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()));
  },
});

// Starts connecting: returns the GitHub page for the app to open. returnTo is "app" (turtl://) or, on the web, the
// page's own origin on this computer. start "install" (the default) opens GitHub's install page, where the owner
// chooses repositories; "authorize" goes straight to authorizing turtl, for someone whose installation already exists.
// Both end at the same callback, which connects only what GitHub lists for the person.
export const begin = action({
  args: { returnTo: v.string(), start: v.optional(v.union(v.literal("install"), v.literal("authorize"))) },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { returnTo, start }) => {
    const account: string = await ctx.runQuery(internal.access.account, {});
    const connect = connectConfig();
    if (!connect.ok) throw new ConvexError(NOT_SET_UP);
    const target = returnAddress(returnTo);
    if (!target) throw new ConvexError("turtl can only bring you back to the turtl app after GitHub.");
    const state = randomSecret();
    const codeVerifier = randomSecret();
    await ctx.runMutation(internal.github.connect.start, { account, stateHash: await sha256(state), codeVerifier, returnTo: target });
    return {
      url: start === "authorize" ? await authorizeUrl(connect, state, codeVerifier) : `${githubWebUrl()}/apps/${encodeURIComponent(connect.slug)}/installations/new?state=${state}`,
    };
  },
});

// Finishes connecting with the ticket GitHub's last redirect carried. Only the account that started the attempt can.
export const finish = mutation({
  args: { ticket: v.string() },
  returns: v.object({ connected: v.number(), githubLogin: v.string() }),
  handler: async (ctx, { ticket }) => {
    const account = await requireAccount(ctx);
    const ticketHash = await sha256(ticket);
    const attempt = await ctx.db
      .query("githubConnectAttempts")
      .withIndex("by_ticket", (q) => q.eq("ticketHash", ticketHash))
      .unique();
    // One answer for an unknown, used, expired or someone else's ticket, so a ticket cannot be probed.
    if (!attempt || attempt.status !== "confirmed" || attempt.expiresAt <= Date.now() || attempt.account !== account) throw new ConvexError(EXPIRED);
    const links = await attemptLinks(ctx, attempt._id);
    for (const link of links) {
      const earlier = await ctx.db
        .query("githubInstallationLinks")
        .withIndex("by_account_and_installation", (q) => q.eq("account", account).eq("installationId", link.installationId))
        .take(SCAN);
      for (const old of earlier) if (old._id !== link._id) await ctx.db.delete(old._id);
      await ctx.db.patch(link._id, { active: true });
    }
    await ctx.db.patch(attempt._id, { status: "finished", codeVerifier: "" });
    return { connected: links.length, githubLogin: attempt.githubLogin ?? "" };
  },
});

// Reads the caller's installations from GitHub again, so the picker shows what GitHub has now. With accounts on it
// also asks GitHub again what the caller can change in someone else's account (an organization), drops what they no
// longer can, and returns what GitHub listed for them that turtl left out, with why, for the app to show.
export const refresh = action({
  args: {},
  returns: v.object({ ok: v.boolean(), problems: v.array(v.string()), leftOut: v.optional(v.array(v.object({ fullName: v.string(), message: v.string() }))) }),
  handler: async (ctx) => {
    const account: string = await ctx.runQuery(internal.access.account, {});
    if (!connectConfig().ok) return { ok: false, problems: [NOT_SET_UP] };
    const installationIds: number[] = await ctx.runQuery(internal.github.connect.linkedInstallations, { account });
    const problems: string[] = [];
    for (const installationId of installationIds) {
      const refreshed = await refreshInstallation(ctx, installationId);
      const rechecked = refreshed.ok && accessEnforced() ? await recheckIfDue(ctx, account, installationId) : refreshed;
      if (!rechecked.ok) problems.push(rechecked.message);
    }
    const leftOut: { fullName: string; message: string }[] = await ctx.runQuery(internal.github.links.leftOutOf, { account });
    return { ok: problems.length === 0, problems, leftOut };
  },
});

// Disconnects all of the caller's GitHub. In the single-owner demo it is an owner decision behind the owner passcode.
export const disconnect = action({
  args: { passcode: v.optional(v.string()) },
  returns: vDisconnected,
  handler: async (ctx, { passcode }) => {
    await ctx.runQuery(internal.github.connect.ownerDecision, { passcode });
    const account: string = await ctx.runQuery(internal.access.account, {});
    return await disconnectAll(ctx, account);
  },
});

// ---------------------------------------------------------------------------------------------- internal

/**
 * The whole disconnect for one account, for account deletion (RC-23) as well as Disconnect. turtl uninstalls its app
 * only from an installation the person is entitled to remove and no other account uses: with accounts on, one on
 * their own GitHub account (in the single-owner demo, any, as before). GitHub gives turtl's app no way to confirm
 * that someone owns an organization (that needs the organization's Members permission, which turtl does not ask
 * for), so from an organization's installation, or someone else's, turtl only removes this account's link and its
 * cached token, and says who can remove the app. Safe to run again: it returns what it could not uninstall.
 */
export const disconnectAccount = internalAction({
  args: { account: v.string() },
  returns: vDisconnected,
  handler: async (ctx, { account }) => await disconnectAll(ctx, account),
});

export const installationName = internalQuery({
  args: { installationId: v.number() },
  returns: v.object({ accountLogin: v.string(), accountType: v.optional(v.string()) }),
  handler: async (ctx, { installationId }) => {
    const row = await installationRow(ctx, installationId);
    return { accountLogin: row?.accountLogin || "that GitHub account", ...(row?.accountType && { accountType: row.accountType }) };
  },
});

async function disconnectAll(ctx: ActionCtx, account: string) {
  const installationIds: number[] = await ctx.runQuery(internal.github.links.installationsOf, { account });
  const app = appConfig();
  const jwt = app.state === "ready" ? await signAppJwt(app.appId, app.privateKey) : null;
  const failed: { installationId: number; message: string }[] = [];
  const stillInstalled: { installationId: number; accountLogin: string; message: string }[] = [];
  let disconnected = 0;
  for (const installationId of installationIds) {
    const others: number = await ctx.runQuery(internal.github.links.otherAccounts, { installationId, account });
    const link: { own: boolean } | null = await ctx.runQuery(internal.github.links.linkFor, { account, installationId });
    const entitled = !accessEnforced() || link?.own === true;
    if (others > 0 || !entitled) {
      await ctx.runMutation(internal.github.links.unlink, { account, installationId });
      const { accountLogin, accountType }: { accountLogin: string; accountType?: string } = await ctx.runQuery(internal.github.connect.installationName, { installationId });
      stillInstalled.push({ installationId, accountLogin, message: STILL_INSTALLED(accountLogin, accountType, entitled) });
    } else {
      if (!jwt) {
        failed.push({ installationId, message: app.state === "ready" ? UNREADABLE_KEY : "turtl's GitHub App is not configured on this deployment, so turtl could not uninstall it." });
        continue;
      }
      const deleted = await deleteInstallation(jwt, installationId);
      // 404: GitHub no longer has it, which is the outcome asked for.
      if (!deleted.ok && deleted.status !== 404) {
        failed.push({ installationId, message: deleted.message });
        continue;
      }
      await ctx.runMutation(internal.github.installations.markDeleted, { installationId });
    }
    disconnected += 1;
  }
  if (failed.length === 0) await ctx.runMutation(internal.github.connect.forgetAttempts, { account });
  return { ok: failed.length === 0, disconnected, failed, stillInstalled };
}

export const ownerDecision = internalQuery({
  args: { passcode: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { passcode }) => {
    if (accessEnforced()) return null;
    try {
      await requireOwnerPasscode(ctx, passcode, true);
    } catch (error) {
      if (error instanceof ConvexError && /^Set an owner passcode/.test(String(error.data))) throw new ConvexError(PASSCODE_FIRST);
      throw error;
    }
    return null;
  },
});

export const linkedInstallations = internalQuery({
  args: { account: v.string() },
  returns: v.array(v.number()),
  handler: async (ctx, { account }) => (await activeLinks(ctx, account)).map((link) => link.installationId),
});

// A new attempt replaces the account's earlier ones, so each account has at most one in flight.
export const start = internalMutation({
  args: { account: v.string(), stateHash: v.string(), codeVerifier: v.string(), returnTo: v.string() },
  returns: v.null(),
  handler: async (ctx, { account, stateHash, codeVerifier, returnTo }) => {
    await forget(ctx, account);
    await ctx.db.insert("githubConnectAttempts", { account, stateHash, codeVerifier, returnTo, status: "started", expiresAt: Date.now() + ATTEMPT_MS });
    return null;
  },
});

export const forgetAttempts = internalMutation({
  args: { account: v.string() },
  returns: v.null(),
  handler: async (ctx, { account }) => {
    await forget(ctx, account);
    return null;
  },
});

const attemptByState = (ctx: QueryCtx, stateHash: string) =>
  ctx.db
    .query("githubConnectAttempts")
    .withIndex("by_state", (q) => q.eq("stateHash", stateHash))
    .unique();

// For /github/setup: the attempt a state belongs to while it is waiting for GitHub. Reading it changes nothing.
export const waiting = internalQuery({
  args: { stateHash: v.string() },
  returns: v.union(v.object({ returnTo: v.string(), codeVerifier: v.string() }), v.null()),
  handler: async (ctx, { stateHash }) => {
    const attempt = await attemptByState(ctx, stateHash);
    return attempt?.status === "started" && attempt.expiresAt > Date.now() ? { returnTo: attempt.returnTo, codeVerifier: attempt.codeVerifier } : null;
  },
});

// For /github/callback: takes the attempt a state belongs to, once. A second callback with the same state finds it taken.
export const claim = internalMutation({
  args: { stateHash: v.string() },
  returns: v.union(v.object({ attemptId: v.id("githubConnectAttempts"), returnTo: v.string(), codeVerifier: v.string() }), v.null()),
  handler: async (ctx, { stateHash }) => {
    const attempt = await attemptByState(ctx, stateHash);
    if (attempt?.status !== "started" || attempt.expiresAt <= Date.now()) return null;
    await ctx.db.patch(attempt._id, { status: "claimed" });
    return { attemptId: attempt._id, returnTo: attempt.returnTo, codeVerifier: attempt.codeVerifier };
  },
});

export const fail = internalMutation({
  args: { attemptId: v.id("githubConnectAttempts") },
  returns: v.null(),
  handler: async (ctx, { attemptId }) => {
    // A newer attempt by the same account may have replaced this one meanwhile.
    if (await ctx.db.get(attemptId)) await ctx.db.patch(attemptId, { status: "failed", codeVerifier: "" });
    return null;
  },
});

// What GitHub confirmed for the person who came back: inactive links, one per installation they can reach, and the
// hash of the ticket that lets the starting account make them active.
export const confirm = internalMutation({
  args: {
    attemptId: v.id("githubConnectAttempts"),
    ticketHash: v.string(),
    githubUserId: v.number(),
    githubLogin: v.string(),
    // repositories: absent for an installation on the person's own account. checked: GitHub said the person can change
    // each one listed (accounts on), and leftOut what it listed that they cannot.
    installations: v.array(
      v.object({ installationId: v.number(), repositories: v.optional(v.array(v.string())), checked: v.optional(v.boolean()), leftOut: v.optional(v.array(vLeftOut)) }),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, { attemptId, ticketHash, githubUserId, githubLogin, installations }) => {
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.status !== "claimed") return false;
    const confirmedAt = Date.now();
    for (const { installationId, repositories, checked, leftOut } of installations) {
      await ctx.db.insert("githubInstallationLinks", {
        account: attempt.account,
        installationId,
        attemptId,
        active: false,
        githubUserId,
        githubLogin,
        ...(repositories && { repositories: repositories.map((name) => name.toLowerCase()) }),
        ...(repositories && checked && { checkedAt: confirmedAt }),
        ...(leftOut?.length && { leftOut: mergeLeftOut([], leftOut) }),
        confirmedAt,
      });
    }
    await ctx.db.patch(attemptId, { status: "confirmed", ticketHash, githubUserId, githubLogin, codeVerifier: "", expiresAt: confirmedAt + TICKET_MS });
    return true;
  },
});
