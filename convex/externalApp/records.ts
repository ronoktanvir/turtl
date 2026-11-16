import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation } from "../_generated/server";
import { SOLO_OWNER } from "../decisions";
import { startCaseRun } from "../runner/run";
import { vExternalApp } from "./validators";

declare const process: { env: Record<string, string | undefined> };

const { appId: _app, journeyId: _journey, actionCatalogId: _catalog, ...configuration } = vExternalApp.fields;

export const register = internalMutation({
  args: { name: v.string(), config: v.object(configuration) },
  handler: async (ctx, { name, config }): Promise<{ appId: Id<"apps">; externalAppId: Id<"externalApps"> }> => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error("Use owner/repository for the game repository.");
    if (!config.baseBranch.trim() || !config.probe.workflow.trim()) throw new Error("A base branch and probe workflow are required.");
    if (config.baselineSha && !/^[a-f0-9]{40}$/.test(config.baselineSha)) throw new Error("The baseline must be a full commit SHA.");
    const url = new URL(config.deploymentUrl);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Use a deployment URL without credentials or query parameters.");
    if (config.deployTimeoutMinutes <= 0 || config.deployTimeoutMinutes > 60) throw new Error("Deploy timeout must be between zero and 60 minutes.");
    if (config.probe.viewport.width !== 390 || config.probe.viewport.height !== 844) throw new Error("The gameplay evidence viewport is 390×844.");
    const previous = (await ctx.db.query("externalApps").collect()).find((row) => row.repo === config.repo && row.environment === config.environment);
    if (previous) return { appId: previous.appId, externalAppId: previous._id };
    const appId = await ctx.db.insert("apps", { name: name.trim(), repoUrl: `https://github.com/${config.repo}`, productionUrl: config.deploymentUrl.replace(/\/$/, ""), ownerId: SOLO_OWNER.identity });
    const journeyId = await ctx.db.insert("journeys", {
      appId, name: "Play several rounds and save a score",
      description: "A real browser answers several rounds, retries a request, ends a game and checks its saved score against accumulated synthetic history. A homepage alone proves nothing.",
      check: { kind: "http", config: { url: `${config.deploymentUrl.replace(/\/$/, "")}${config.revisionPath}`, method: "GET", expectedStatus: 200 } },
      checkVersion: "listener-ladder-gameplay-v1",
    });
    const actionCatalogId = await ctx.db.insert("actionCatalog", {
      appId, type: "open_pull_request", name: "Prepare a code repair in a pull request",
      description: "Capy prepares exactly the approved repair. The owner reviews and merges; gameplay is checked only after the merge commit is deployed.", reversible: true,
      config: { kind: "capy", repoUrl: `https://github.com/${config.repo}`, baseBranch: config.baseBranch },
      parameterConstraints: [{ name: "title", type: "string", required: true }, { name: "change", type: "string", required: true }],
    });
    const externalAppId = await ctx.db.insert("externalApps", { ...config, appId, journeyId, actionCatalogId });
    return { appId, externalAppId };
  },
});

export const forApp = internalQuery({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => ctx.db.query("externalApps").withIndex("by_app", (q) => q.eq("appId", appId)).first(),
});

export const all = internalQuery({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db.query("externalApps").collect();
    return await Promise.all(apps.map(async (app) => ({ app, probes: await ctx.db.query("probeRuns").withIndex("by_app", (q) => q.eq("appId", app.appId)).order("desc").take(20) })));
  },
});

export const probe = internalQuery({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, { probeRunId }) => {
    const run = await ctx.db.get(probeRunId);
    return run ? { run, app: await ctx.db.get(run.externalAppId) } : null;
  },
});

export const pullRequests = internalQuery({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const cases = await ctx.db.query("cases").filter((q) => q.eq(q.field("appId"), appId)).collect();
    const rows = await Promise.all(cases.map((row) => ctx.db.query("pullRequests").withIndex("by_case", (q) => q.eq("caseId", row._id)).order("desc").first()));
    return rows.filter((row): row is Doc<"pullRequests"> => !!row);
  },
});

export const holdClock = internalMutation({
  args: { attemptId: v.id("stepAttempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt) throw new Error("Attempt not found.");
    const app = await ctx.db.get(attempt.caseId);
    if (!app || !(await ctx.db.query("externalApps").withIndex("by_app", (q) => q.eq("appId", app.appId)).first())) throw new Error("Only a registered external case can hold its asynchronous clock.");
    const jobs = await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", (q) => q.gt("_creationTime", Date.now() - 15 * 60_000)).collect();
    for (const job of jobs) {
      if (job.state.kind === "pending" && job.name.endsWith("checkTimeout") && job.args[0]?.attemptId === attemptId) await ctx.scheduler.cancel(job._id);
    }
  },
});

export const openFromProbe = internalMutation({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, { probeRunId }): Promise<Id<"cases"> | null> => {
    const run = await ctx.db.get(probeRunId);
    if (!run || run.purpose !== "monitor" || run.outcome !== "failed" || !run.result) return null;
    const app = await ctx.db.get(run.externalAppId);
    if (!app || app.isTestDouble) return null;
    const previous = await ctx.db.query("cases").withIndex("by_app_and_signature", (q) => q.eq("appId", app.appId).eq("signature", `gameplay_failed:${app.journeyId}`)).collect();
    const open = previous.find((row) => !["resolved", "restored", "declined", "unresolved"].includes(row.status));
    if (open) return open._id;
    const last = previous.sort((a, b) => b._creationTime - a._creationTime)[0];
    const journey = await ctx.db.get(app.journeyId);
    if (last && (journey?.lastPassedAt ?? 0) <= last._creationTime) return last._id;
    const caseId = await startCaseRun(ctx, {
      appId: app.appId, kind: "outage", raisedBy: "monitor", raisedByRef: `probeRuns/${run._id}`,
      title: "Players cannot finish a game", impact: `A real gameplay probe failed at ${run.result.failedStep ?? "an answer"}. The fixture represents accumulated synthetic score history, not traffic.`,
      signature: `gameplay_failed:${app.journeyId}`,
    });
    await ctx.db.patch(caseId, { journeyId: app.journeyId });
    await ctx.db.patch(run._id, { caseId });
    await ctx.scheduler.runAfter(0, internal.keiki.notifyOwner, { text: "A real gameplay check failed. turtl opened a case and is investigating the answer request." });
    return caseId;
  },
});

export const report = mutation({
  args: { appId: v.id("apps"), text: v.string(), requestId: v.string() },
  handler: async (ctx, { appId, text, requestId }): Promise<{ caseId: Id<"cases"> }> => {
    if (process.env.EXTERNAL_APPS_ENABLED !== "true") throw new Error("External app reports are not enabled on this deployment.");
    const app = await ctx.db.get(appId);
    const config = await ctx.db.query("externalApps").withIndex("by_app", (q) => q.eq("appId", appId)).first();
    if (!app || app.ownerId !== SOLO_OWNER.identity || app.isSample || !config || config.isTestDouble) throw new Error("This is not the solo owner's connected game.");
    const body = text.trim();
    if (!body || body.length > 2000 || !requestId.trim() || requestId.length > 200) throw new Error("Provide a report of at most 2000 characters and a request ID.");
    const previous = await ctx.db.query("reports").withIndex("by_app_and_provider_event", (q) => q.eq("appId", appId).eq("provider", "owner-form").eq("providerEventId", requestId)).first();
    if (previous?.caseId) return { caseId: previous.caseId };
    const caseId = await startCaseRun(ctx, { appId, title: "The owner reported a gameplay problem", impact: body, kind: "bug_report", raisedBy: "owner", raisedByRef: requestId });
    await ctx.db.patch(caseId, { journeyId: config.journeyId, reportCount: 1, distinctRequesterCount: 1 });
    await ctx.db.insert("reports", { appId, caseId, text: body, channel: "form", fromRef: SOLO_OWNER.identity, provider: "owner-form", providerEventId: requestId, receivedAt: Date.now() });
    return { caseId };
  },
});
