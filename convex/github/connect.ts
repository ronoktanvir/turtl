import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { accessEnforced, currentAccount, requireAccount } from "../access";
import { requireOwnerPasscode } from "../ownerPasscode";
import { deleteInstallation } from "./api";
import { appConfig, connectConfig, githubWebUrl, installationSettingsUrl, returnAddress } from "./config";
import { signAppJwt, UNREADABLE_KEY } from "./jwt";
import { activeLinks, linkAllows } from "./links";
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
// 4. disconnect: uninstalls the app at GitHub when no other account uses the installation, and deletes the records.

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
});

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

// Starts connecting: returns GitHub's install page for the app to open. returnTo is "app" (turtl://) or, on the web,
// the page's own origin on this computer.
export const begin = action({
  args: { returnTo: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { returnTo }) => {
    const account = await requireAccount(ctx);
    const connect = connectConfig();
    if (!connect.ok) throw new ConvexError(NOT_SET_UP);
    const target = returnAddress(returnTo);
    if (!target) throw new ConvexError("turtl can only bring you back to the turtl app after GitHub.");
    const state = randomSecret();
    await ctx.runMutation(internal.github.connect.start, { account, stateHash: await sha256(state), codeVerifier: randomSecret(), returnTo: target });
    return { url: `${githubWebUrl()}/apps/${encodeURIComponent(connect.slug)}/installations/new?state=${state}` };
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

// Reads the caller's installations from GitHub again, so the picker shows what GitHub has now.
export const refresh = action({
  args: {},
  returns: v.object({ ok: v.boolean(), problems: v.array(v.string()) }),
  handler: async (ctx) => {
    const account = await requireAccount(ctx);
    if (!connectConfig().ok) return { ok: false, problems: [NOT_SET_UP] };
    const installationIds: number[] = await ctx.runQuery(internal.github.connect.linkedInstallations, { account });
    const problems: string[] = [];
    for (const installationId of installationIds) {
      const refreshed = await refreshInstallation(ctx, installationId);
      if (!refreshed.ok) problems.push(refreshed.message);
    }
    return { ok: problems.length === 0, problems };
  },
});

// Disconnects all of the caller's GitHub. In the single-owner demo it is an owner decision behind the owner passcode.
export const disconnect = action({
  args: { passcode: v.optional(v.string()) },
  returns: vDisconnected,
  handler: async (ctx, { passcode }) => {
    await ctx.runQuery(internal.github.connect.ownerDecision, { passcode });
    const account = await requireAccount(ctx);
    return await disconnectAll(ctx, account);
  },
});

// ---------------------------------------------------------------------------------------------- internal

/**
 * The whole disconnect for one account, for account deletion (RC-23): every installation only this account uses is
 * uninstalled at GitHub, and its token, repositories and links are deleted; the account's links to installations
 * other accounts still use are removed. Safe to run again: it returns what it could not uninstall.
 */
export const disconnectAccount = internalAction({
  args: { account: v.string() },
  returns: vDisconnected,
  handler: async (ctx, { account }) => await disconnectAll(ctx, account),
});

async function disconnectAll(ctx: ActionCtx, account: string) {
  const installationIds: number[] = await ctx.runQuery(internal.github.links.installationsOf, { account });
  const app = appConfig();
  const jwt = app.state === "ready" ? await signAppJwt(app.appId, app.privateKey) : null;
  const failed: { installationId: number; message: string }[] = [];
  let disconnected = 0;
  for (const installationId of installationIds) {
    const others: number = await ctx.runQuery(internal.github.links.otherAccounts, { installationId, account });
    if (others > 0) {
      await ctx.runMutation(internal.github.links.unlink, { account, installationId });
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
  return { ok: failed.length === 0, disconnected, failed };
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
    installations: v.array(v.object({ installationId: v.number(), repositories: v.optional(v.array(v.string())) })),
  },
  returns: v.boolean(),
  handler: async (ctx, { attemptId, ticketHash, githubUserId, githubLogin, installations }) => {
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.status !== "claimed") return false;
    const confirmedAt = Date.now();
    for (const { installationId, repositories } of installations) {
      await ctx.db.insert("githubInstallationLinks", {
        account: attempt.account,
        installationId,
        attemptId,
        active: false,
        githubUserId,
        githubLogin,
        ...(repositories && { repositories: repositories.map((name) => name.toLowerCase()) }),
        confirmedAt,
      });
    }
    await ctx.db.patch(attemptId, { status: "confirmed", ticketHash, githubUserId, githubLogin, codeVerifier: "", expiresAt: confirmedAt + TICKET_MS });
    return true;
  },
});
