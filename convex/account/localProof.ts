import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { localBackend } from "../demoSettings";
import schema from "../schema";

// Seeds and reads for scripts/account-deletion/prove-local.mjs, which deletes an account on a local Convex backend
// against stand-ins for Supermemory, GitHub and Apple. Internal, and refused anywhere but a backend on this machine.

function requireLocalProof() {
  if (!localBackend()) throw new Error("Account deletion proofs run only on a local backend.");
}

/** One project with a case and its steps, a proposal and the owner's decision, evidence, a chat message, a customer
 * report, a preference, a phone, the AI permission, a report key, a code map and a GitHub link, for an account. */
export const seed = internalMutation({
  args: { account: v.string(), label: v.string(), installationId: v.number() },
  returns: v.object({ appId: v.id("apps"), caseId: v.id("cases"), ids: v.array(v.string()) }),
  handler: async (ctx, { account, label, installationId }) => {
    requireLocalProof();
    const ids: string[] = [];
    const add = async <T extends TableNames>(table: T, fields: Record<string, unknown>): Promise<Id<T>> => {
      const id = await ctx.db.insert(table, fields as never);
      ids.push(id);
      return id as Id<T>;
    };
    const now = Date.now();
    const appId = await add("apps", { name: `${label}'s shop`, ownerId: account, repoUrl: `https://github.com/${label}/shop`, productionUrl: `https://${label}.example.com` });
    const caseId = await add("cases", { appId, title: "Checkout is down", impact: "Nobody can pay.", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" });
    const planStep = await add("steps", { caseId, key: "plan", title: "Plan", dependsOn: [], kind: "agent", purpose: "plan", status: "done" });
    const approval = await add("steps", { caseId, key: "authorize_and_execute", title: "Your decision", dependsOn: ["plan"], kind: "approval", purpose: "authorize_and_execute", status: "waiting" });
    const attempt = await add("stepAttempts", { stepId: planStep, caseId, attempt: 1, status: "done", summary: `${label}'s checkout throws at pay().` });
    await add("evidence", { caseId, stepId: planStep, stepAttemptId: attempt, kind: "error_log", title: "TypeError in pay()", observedAt: now, environment: "production", revision: { commitSha: "abc1234" } });
    const proposalId = await add("proposals", { caseId, stepId: approval, version: 1, decisionStatus: "approved", options: [], doneMeans: [], decidedAt: now, chosenBy: { kind: "owner", identity: account } });
    await add("ownerDecisions", { appId, caseId, proposalId, proposalVersion: 1, outcome: "approved", conditionsKey: "checkout", conditionsText: "Checkout is down", decidedAt: now });
    await add("fixChatMessages", { caseId, role: "owner", text: `${label}: why is checkout down?`, at: now });
    await add("ownerNotices", { caseId, event: "needs_decision", outcome: "pending", observedAt: now });
    const reportId = await add("reports", { appId, caseId, channel: "form", fromRef: `form:device:${label}-customer`, text: `${label}'s customer: I can't pay.`, provider: "turtl-form", providerEventId: `${label}-1`, receivedAt: now });
    await add("reportTriage", { reportId, appId, fingerprint: "pay", status: "done", outcome: "attached", caseId });
    await add("ownerPreferences", { appId, statement: "Never restart checkout during a sale.", source: "settings" });
    await add("intakeKeys", { appId, key: `key-${label}-${now}`, createdAt: now });
    await add("codeNetworks", { projectId: appId, repo: `${label}/shop`, ref: "main", namespace: `code_${appId}`, source: "built", generatedAt: now, clusters: [], nodes: [], edges: [] });
    await add("pushTokens", { account, token: `ExponentPushToken[${label}-${now}]`, platform: "ios", addedAt: now, lastSeenAt: now });
    await add("aiConsents", { account, answer: "allowed", services: [], listVersion: "local-proof", answeredAt: now });
    await add("githubInstallations", { installationId, accountLogin: `${label}-octo`, repositorySelection: "selected", accountType: "User", status: "active", updatedAt: now });
    await add("githubInstallationRepositories", { installationId, fullName: `${label}-octo/shop`, fullNameLower: `${label}-octo/shop`, seenAt: now });
    const attemptId = await add("githubConnectAttempts", { account, stateHash: `state-${label}`, codeVerifier: "", returnTo: "turtl://add-project", status: "finished", expiresAt: now });
    await add("githubInstallationLinks", { account, installationId, attemptId, active: true, githubUserId: installationId * 10, githubLogin: `${label}-octo`, confirmedAt: now });
    return { appId, caseId, ids };
  },
});

/** A screenshot of the case in Convex storage, as Revyl's device runs keep them. */
export const screenshot = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.array(v.string()),
  handler: async (ctx, { caseId }): Promise<string[]> => {
    requireLocalProof();
    const storageId = await ctx.storage.store(new Blob(["a screenshot of the owner's app"], { type: "image/png" }));
    const rows: string[] = await ctx.runMutation(internal.account.localProof.keepScreenshot, { caseId, storageId });
    return [storageId, ...rows];
  },
});

export const keepScreenshot = internalMutation({
  args: { caseId: v.id("cases"), storageId: v.id("_storage") },
  returns: v.array(v.string()),
  handler: async (ctx, { caseId, storageId }) => {
    requireLocalProof();
    const now = Date.now();
    const runId = await ctx.db.insert("revylRuns", { caseId, phase: "failure", workflowId: "local-proof", taskId: `task-${now}`, status: "passed", startedAt: now });
    const shotId = await ctx.db.insert("revylScreenshots", { runId, caseId, phase: "failure", storageId, caption: "Checkout", takenAt: now });
    return [runId, shotId];
  },
});

/** Every row in every table that names one of these ids or words, as text, and which of the files still exist. */
export const find = internalQuery({
  args: { markers: v.array(v.string()) },
  returns: v.object({ rows: v.record(v.string(), v.array(v.string())), files: v.array(v.string()) }),
  handler: async (ctx, { markers }) => {
    requireLocalProof();
    const mentions = (text: string) => markers.some((marker) => new RegExp(`(?<![A-Za-z0-9_])${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).test(text));
    const rows: Record<string, string[]> = {};
    for (const table of Object.keys(schema.tables) as TableNames[]) {
      const found = (await ctx.db.query(table).take(2000)).map((row) => JSON.stringify(row)).filter(mentions);
      if (found.length) rows[table] = found.sort();
    }
    const files: string[] = [];
    for (const marker of markers) {
      const id = ctx.db.system.normalizeId("_storage", marker);
      if (id && (await ctx.db.system.get(id))) files.push(marker);
    }
    return { rows, files };
  },
});
