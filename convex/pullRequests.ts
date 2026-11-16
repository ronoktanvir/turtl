import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { action, mutation, query } from "./functions";
import { canSeeCase, guardCaseInAction, ownerActor, requireDevTools } from "./access";
import { gateFor } from "./consent/gate";
import { repositoryAccess, type Purpose } from "./github/access";
import { findPullRequestNumber } from "./prTracking/capy";
import { capyConfigFor } from "./prTracking/codingAgent";
import { registerCodeChangeAction } from "./prTracking/catalog";
import { mergePullRequest, parsePullRequestUrl, readPullRequest } from "./prTracking/github";
import { latestForCase, toPullRequest } from "./prTracking/records";
import { pullRequestOf, type PullRequest } from "./prTracking/validators";
import { readRevision } from "./protectedApp/client";
import { watchedApp } from "./protectedApp/watched";

declare const process: { env: Record<string, string | undefined> };

const OPENING_GRACE_MS = 2 * 60_000;

type NotConfigured = { outcome: "not_configured"; missing: string[] };
type Failed = { outcome: "failed"; message: string };
export type RefreshResult = { outcome: "synced"; pullRequest: PullRequest } | { outcome: "opening" } | { outcome: "none" } | NotConfigured | Failed;
export type MergeResult = { outcome: "merged"; pullRequest: PullRequest } | { outcome: "refused"; reason: string } | NotConfigured | Failed;

const NO_GITHUB_TOKEN: NotConfigured = { outcome: "not_configured", missing: ["GITHUB_TOKEN"] };

// The credential for one repository: a GitHub App installation token, or GITHUB_TOKEN while the app is not configured.
// With accounts on, only an installation the case's project owner connected, and to merge ("change"), only while
// GitHub says the owner can change the repository themself.
async function githubAccess(ctx: ActionCtx, repo: string, caseId: string, purpose: Purpose = "read"): Promise<{ token: string } | NotConfigured | Failed> {
  const access = await repositoryAccess(ctx, repo, { caseId }, purpose);
  if (!access.ok) return { outcome: "failed", message: access.message };
  return access.token ? { token: access.token } : NO_GITHUB_TOKEN;
}

// Brings one pull request up to date: finds its number in Capy's reply while it is being opened, then
// reads GitHub. A merge or close seen here settles the execute step waiting on it.
async function sync(ctx: ActionCtx, row: Doc<"pullRequests">): Promise<RefreshResult> {
  if (row.settledAt !== undefined) return { outcome: "none" };
  let number = row.number;
  if (number === undefined) {
    if (!row.capyThreadId) return { outcome: "failed", message: "This pull request has no number and no Capy thread." };
    const capy = await capyConfigFor(ctx, { caseId: row.caseId });
    if (!capy.ok) return { outcome: "not_configured", missing: capy.missing };
    const found = await findPullRequestNumber(gateFor(ctx, { caseId: row.caseId }), capy, row.capyThreadId, row.repo, row.capyCursor);
    if (!found.ok) {
      await ctx.runMutation(internal.prTracking.records.recordSyncError, { id: row._id, error: found.message });
      return { outcome: "failed", message: found.message };
    }
    if (found.body.cursor && found.body.cursor !== row.capyCursor) {
      await ctx.runMutation(internal.prTracking.records.setCapyCursor, { id: row._id, cursor: found.body.cursor });
    }
    if (found.body.number === undefined) {
      if (found.body.stopped && Date.now() - row.requestedAt > OPENING_GRACE_MS) {
        const message = `Capy stopped (${found.body.status}) without opening a pull request in ${row.repo}.`;
        await ctx.runMutation(internal.prTracking.records.failOpening, { id: row._id, error: message });
        return { outcome: "failed", message };
      }
      return { outcome: "opening" };
    }
    number = found.body.number;
    await ctx.runMutation(internal.prTracking.records.setNumber, { id: row._id, number });
  }
  const access = await githubAccess(ctx, row.repo, row.caseId);
  if ("outcome" in access) return access;
  const read = await readPullRequest(access.token, row.repo, number);
  if (!read.ok) {
    await ctx.runMutation(internal.prTracking.records.recordSyncError, { id: row._id, error: read.message });
    return { outcome: "failed", message: read.message };
  }
  await ctx.runMutation(internal.prTracking.records.applySnapshot, { id: row._id, ...read.body });
  const deployment = await ctx.runQuery(internal.prTracking.records.deploymentTarget, { id: row._id });
  if (deployment) {
    const revision = await readRevision(deployment.base, await watchedApp(ctx, { caseId: row.caseId }));
    if (revision === deployment.expectedRevision) {
      await ctx.runMutation(internal.prTracking.records.confirmDeployment, { id: row._id, revision });
    } else {
      await ctx.runMutation(internal.prTracking.records.recordSyncError, {
        id: row._id,
        error: `Waiting for deployed revision ${deployment.expectedRevision}; the booking app reports ${revision ?? "no revision"}.`,
      });
    }
  }
  return { outcome: "synced", pullRequest: pullRequestOf(row.repo, number, read.body.snapshot) };
}

// The case's pull request in the UI contract's PullRequest shape, or null when it has none yet (or the
// id is not a case). While Capy is still writing the change this stays null.
export const forCase = query({
  args: { caseId: v.string() },
  handler: async (ctx, args): Promise<PullRequest | null> => {
    if (!(await canSeeCase(ctx, args.caseId))) return null;
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    const row = caseId && (await latestForCase(ctx, caseId));
    return row ? toPullRequest(row) : null;
  },
});

// Reads the case's pull request from GitHub now, rather than waiting for the cron.
export const refresh = action({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }): Promise<RefreshResult> => {
    await guardCaseInAction(ctx, caseId);
    const row: Doc<"pullRequests"> | null = await ctx.runQuery(internal.prTracking.records.forCase, { caseId });
    return row ? await sync(ctx, row) : { outcome: "none" };
  },
});

// Every 30 seconds: every pull request still being opened or still open.
export const refreshActive = internalAction({
  args: {},
  handler: async (ctx): Promise<RefreshResult["outcome"][]> => {
    const rows: Doc<"pullRequests">[] = await ctx.runQuery(internal.prTracking.records.active, {});
    const outcomes: RefreshResult["outcome"][] = [];
    for (const row of rows) outcomes.push((await sync(ctx, row)).outcome);
    return outcomes;
  },
});

// The owner's Merge tap. It reads GitHub fresh and merges only when the pull request is open, its
// checks pass, GitHub can merge it, and its head is still the commit the owner was shown (headSha).
export const merge = action({
  args: { caseId: v.id("cases"), headSha: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { caseId, headSha, passcode }): Promise<MergeResult> => {
    const account = await guardCaseInAction(ctx, caseId);
    await ctx.runQuery(internal.ownerPasscode.authorize, { passcode });
    const row: Doc<"pullRequests"> | null = await ctx.runQuery(internal.prTracking.records.forCase, { caseId });
    if (!row || row.number === undefined) return { outcome: "refused", reason: "This case has no pull request yet." };
    if (row.settledAt !== undefined) return { outcome: "refused", reason: row.openError ?? "turtl is no longer following this pull request." };
    const access = await githubAccess(ctx, row.repo, caseId, "change");
    if ("outcome" in access) return access;
    const { token } = access;
    const read = await readPullRequest(token, row.repo, row.number);
    if (!read.ok) return { outcome: "failed", message: read.message };
    await ctx.runMutation(internal.prTracking.records.applySnapshot, { id: row._id, ...read.body });
    const { snapshot } = read.body;
    const refused = (reason: string): MergeResult => ({ outcome: "refused", reason });
    if (snapshot.state !== "open") return refused(`Pull request #${row.number} is already ${snapshot.state}.`);
    if (snapshot.headSha !== headSha) {
      return refused("The pull request changed after you looked at it: new commits arrived. Look at it again before merging.");
    }
    if (snapshot.checks !== "passing") {
      return refused(snapshot.checks === "none" ? "The pull request has no checks yet. turtl merges only once checks pass." : `Checks are ${snapshot.checks}. turtl merges only once they pass.`);
    }
    if (!snapshot.mergeable) return refused(`GitHub can't merge it right now (${snapshot.mergeableState}).`);

    const allowed = await ctx.runMutation(internal.prTracking.records.beginMerge, { id: row._id, by: ownerActor(account) });
    if (!allowed) return refused("The owner stopped this action or the pull request already finished. Nothing was merged.");
    const merged = await mergePullRequest(token, row.repo, row.number, headSha);
    if (!merged.ok || !merged.body.merged) {
      if (merged.ok || merged.status !== undefined) {
        await ctx.runMutation(internal.prTracking.records.clearMergeRequest, { id: row._id });
      }
      if (merged.ok) return refused(`GitHub did not merge it: ${merged.body.message}`);
      if (merged.status === 405 || merged.status === 409) return refused(`GitHub did not merge it. ${merged.message}`);
      return { outcome: "failed", message: merged.message };
    }
    const after = await readPullRequest(token, row.repo, row.number);
    const mergedSnapshot =
      after.ok && after.body.snapshot.state === "merged"
        ? after.body.snapshot
        : { ...snapshot, state: "merged" as const, mergeable: false, mergeableState: "merged" };
    await ctx.runMutation(internal.prTracking.records.applySnapshot, {
      id: row._id,
      snapshot: mergedSnapshot,
      mergeCommitSha: merged.body.sha,
    });
    return { outcome: "merged", pullRequest: pullRequestOf(row.repo, row.number, mergedSnapshot) };
  },
});

// Dev tools: links an existing GitHub pull request to a case by its URL, so tracking and merging can be
// shown without Capy opening it.
export const attachByUrl = action({
  args: { caseId: v.id("cases"), url: v.string(), fixKey: v.optional(v.string()), passcode: v.optional(v.string()) },
  handler: async (ctx, { caseId, url, fixKey, passcode }): Promise<RefreshResult> => {
    await ctx.runQuery(internal.ownerPasscode.authorize, { passcode });
    requireDevTools();
    const parsed = parsePullRequestUrl(url);
    if (!parsed) return { outcome: "failed", message: "Expected a pull request URL like https://github.com/owner/name/pull/123." };
    const access = await githubAccess(ctx, parsed.repo, caseId);
    if ("outcome" in access) return access;
    const read = await readPullRequest(access.token, parsed.repo, parsed.number);
    if (!read.ok) return { outcome: "failed", message: read.message };
    await ctx.runMutation(internal.prTracking.records.attach, {
      caseId,
      repo: parsed.repo,
      number: parsed.number,
      snapshot: read.body.snapshot,
      ...(fixKey !== undefined && { fixKey }),
    });
    return { outcome: "synced", pullRequest: pullRequestOf(parsed.repo, parsed.number, read.body.snapshot) };
  },
});

// Dev tools: adds the booking app's code-change action (kind "capy") to its catalog.
export const registerCodeChange = mutation({
  args: {},
  handler: async (ctx) => {
    requireDevTools();
    return await registerCodeChangeAction(ctx);
  },
});
