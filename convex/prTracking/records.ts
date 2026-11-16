import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { CLOSED_CASE_STATUSES, vActor } from "../constants";
import type { Actor } from "../constants";
import type { HandlerResult } from "../runner/contract";
import { cancelJobs } from "../runner/jobs";
import { pullRequestOf, vGithubSnapshot, type PullRequest } from "./validators";
import { BOOKING_APP_NAME } from "../protectedApp/registry";
import { waitOnAttempt } from "../workflow";

const GITHUB_ACTOR: Actor = { kind: "service", identity: "github" };

export const toPullRequest = (row: Doc<"pullRequests">): PullRequest | null =>
  row.number === undefined || !row.snapshot ? null : pullRequestOf(row.repo, row.number, row.snapshot);

export const latestForCase = (ctx: QueryCtx, caseId: Id<"cases">) =>
  ctx.db
    .query("pullRequests")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .order("desc")
    .first();

export const forCase = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => latestForCase(ctx, caseId),
});

export const forAction = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) =>
    ctx.db
      .query("pullRequests")
      .withIndex("by_action", (q) => q.eq("actionId", actionId))
      .first(),
});

export const deploymentTarget = internalQuery({
  args: { id: v.id("pullRequests") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined || row.snapshot?.state !== "merged" || !row.mergeCommitSha || !row.actionId) return null;
    const action = await ctx.db.get(row.actionId);
    const caseRow = await ctx.db.get(row.caseId);
    const app = caseRow && await ctx.db.get(caseRow.appId);
    return action?.status !== "cancelled" && action?.executionPayload.config.kind === "capy" && app?.name === BOOKING_APP_NAME && app.productionUrl
      ? { base: app.productionUrl, expectedRevision: row.mergeCommitSha }
      : null;
  },
});

// Pull requests still being opened or still open: the ones the cron keeps fresh.
export const active = internalQuery({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("pullRequests")
      .withIndex("by_settled", (q) => q.eq("settledAt", undefined))
      .collect(),
});

// The runner fails any attempt still running or waiting when its step's time limit passes. A pull
// request waits for the owner's merge, which takes far longer, so the attempt waiting on one drops its
// pending time-limit check. The merge, or the pull request closing, settles the attempt instead.
async function holdStepClock(ctx: MutationCtx, attemptId: Id<"stepAttempts">) {
  await cancelJobs(ctx, await ctx.db.get(attemptId), "checkTimeout");
}

// Finishes the approved action and the execute attempt waiting on this pull request, once.
async function settle(ctx: MutationCtx, row: Doc<"pullRequests">, result: Extract<HandlerResult, { status: "done" | "failed" }>) {
  const now = Date.now();
  await ctx.db.patch(row._id, { settledAt: now });
  const action = row.actionId && (await ctx.db.get(row.actionId));
  if (action && action.status !== "completed" && action.status !== "cancelled") {
    await ctx.db.patch(action._id, {
      status: result.status === "done" ? "completed" : "failed",
      result: result.status === "done" ? result.summary : result.error,
      ...(row.snapshot && { externalRef: row.snapshot.url }),
      completedAt: now,
    });
  }
  if (row.stepAttemptId) {
    await ctx.scheduler.runAfter(0, internal.runner.run.recordResult, { attemptId: row.stepAttemptId, result });
  }
}

export const insertForAction = internalMutation({
  args: {
    actionId: v.id("actions"),
    repo: v.string(),
    baseBranch: v.string(),
    capyThreadId: v.string(),
  },
  handler: async (ctx, { actionId, repo, baseBranch, capyThreadId }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("Action not found.");
    if (action.status === "cancelled") throw new Error("The owner stopped this action. Any Capy work remains external and is not tracked.");
    return await ctx.db.insert("pullRequests", {
      caseId: action.caseId,
      source: "capy",
      repo,
      baseBranch,
      actionId,
      proposalId: action.proposalId,
      fixKey: action.optionKey,
      capyThreadId,
      requestedAt: Date.now(),
    });
  },
});

// Points the pull request at the execute attempt now waiting on it and stops that attempt's clock.
export const waitOn = internalMutation({
  args: { id: v.id("pullRequests"), attemptId: v.id("stepAttempts") },
  handler: async (ctx, { id, attemptId }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined) return;
    await ctx.db.patch(id, { stepAttemptId: attemptId });
    await holdStepClock(ctx, attemptId);
  },
});

export const attach = internalMutation({
  args: {
    caseId: v.id("cases"),
    repo: v.string(),
    number: v.number(),
    snapshot: vGithubSnapshot,
    fixKey: v.optional(v.string()),
  },
  handler: async (ctx, { caseId, repo, number, snapshot, fixKey }) => {
    if (!(await ctx.db.get(caseId))) throw new Error("Case not found.");
    const now = Date.now();
    const existing = (
      await ctx.db
        .query("pullRequests")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect()
    ).find((row) => row.repo === repo && row.number === number);
    const fields = {
      snapshot,
      syncedAt: now,
      ...(fixKey !== undefined && { fixKey }),
      ...(snapshot.state !== "open" && { settledAt: now }),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("pullRequests", { caseId, source: "attached", repo, number, requestedAt: now, ...fields });
  },
});

export const setCapyCursor = internalMutation({
  args: { id: v.id("pullRequests"), cursor: v.string() },
  handler: async (ctx, { id, cursor }) => ctx.db.patch(id, { capyCursor: cursor }),
});

export const setNumber = internalMutation({
  args: { id: v.id("pullRequests"), number: v.number() },
  handler: async (ctx, { id, number }) => ctx.db.patch(id, { number }),
});

export const recordSyncError = internalMutation({
  args: { id: v.id("pullRequests"), error: v.string() },
  handler: async (ctx, { id, error }) => ctx.db.patch(id, { syncError: error, syncedAt: Date.now() }),
});

export const failOpening = internalMutation({
  args: { id: v.id("pullRequests"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined) return;
    await ctx.db.patch(id, { openError: error });
    await settle(ctx, row, { status: "failed", error });
  },
});

// Writes GitHub's latest view. A pull request that merged or closed settles what waits on it; a merge
// is credited to the owner only when it follows their tap in turtl.
export const applySnapshot = internalMutation({
  args: { id: v.id("pullRequests"), snapshot: vGithubSnapshot, mergeCommitSha: v.optional(v.string()) },
  handler: async (ctx, { id, snapshot, mergeCommitSha }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Pull request not found.");
    if (row.actionId && (await ctx.db.get(row.actionId))?.status === "cancelled") return;
    await ctx.db.patch(id, { snapshot, syncedAt: Date.now(), syncError: undefined });
    if (row.settledAt !== undefined || snapshot.state === "open") return;
    const latest = { ...row, snapshot };
    if (snapshot.state === "closed") {
      await settle(ctx, latest, { status: "failed", error: `Pull request #${row.number} was closed without merging.` });
      return;
    }
    const mergedBy = row.mergeRequestedBy ?? GITHUB_ACTOR;
    await ctx.db.patch(id, { mergedAt: row.mergedAt ?? Date.now(), mergedBy: row.mergedBy ?? mergedBy, ...(mergeCommitSha && { mergeCommitSha }) });
    const action = row.actionId && await ctx.db.get(row.actionId);
    const caseRow = action && await ctx.db.get(row.caseId);
    const app = caseRow && await ctx.db.get(caseRow.appId);
    if (action && app?.name === BOOKING_APP_NAME && action.executionPayload.config.kind === "capy") {
      if (row.stepAttemptId) await waitOnAttempt(ctx, row.stepAttemptId, {
        summary: `Pull request #${row.number} was merged. Waiting for the booking app to report deployed revision ${mergeCommitSha ?? row.mergeCommitSha ?? "not yet available"}; no recovery check has run.`,
        externalRef: snapshot.url,
      });
      return;
    }
    await settle(ctx, latest, {
      status: "done",
      summary:
        mergedBy.kind === "owner"
          ? `The owner merged pull request #${row.number} (${snapshot.title}).`
          : `Pull request #${row.number} (${snapshot.title}) was merged on GitHub, outside turtl.`,
      externalRef: snapshot.url,
    });
  },
});

export const confirmDeployment = internalMutation({
  args: { id: v.id("pullRequests"), revision: v.string() },
  handler: async (ctx, { id, revision }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined || row.snapshot?.state !== "merged" || !row.mergeCommitSha || revision !== row.mergeCommitSha) return false;
    const action = row.actionId && await ctx.db.get(row.actionId);
    const caseRow = action && await ctx.db.get(row.caseId);
    const app = caseRow && await ctx.db.get(caseRow.appId);
    if (!action || action.status === "cancelled" || app?.name !== BOOKING_APP_NAME) return false;
    await settle(ctx, row, {
      status: "done",
      summary: `Pull request #${row.number} was merged and the booking app reports deployed revision ${revision}. The approved recovery checks will run next.`,
      externalRef: row.snapshot.url,
    });
    return true;
  },
});

export const beginMerge = internalMutation({
  args: { id: v.id("pullRequests"), by: vActor },
  handler: async (ctx, { id, by }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined) return false;
    const caseRow = await ctx.db.get(row.caseId);
    if (!caseRow || (CLOSED_CASE_STATUSES as readonly string[]).includes(caseRow.status)) return false;
    if (row.actionId && (await ctx.db.get(row.actionId))?.status === "cancelled") return false;
    await ctx.db.patch(id, { mergeRequestedBy: by, mergeRequestedAt: Date.now() });
    return true;
  },
});

export const clearMergeRequest = internalMutation({
  args: { id: v.id("pullRequests") },
  handler: async (ctx, { id }) => ctx.db.patch(id, { mergeRequestedBy: undefined, mergeRequestedAt: undefined }),
});
