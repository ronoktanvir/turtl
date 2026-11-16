import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { vExternalApp, vProbeBaseline, vProbePurpose, vProbeOutcome, vProbeResult, validateBaseline } from "./validators";

const poll = makeFunctionReference<"action", { probeRunId: Id<"probeRuns"> }>("externalApp/probes:poll");
const completed = makeFunctionReference<"action", { probeRunId: Id<"probeRuns"> }>("externalApp/flow:probeCompleted");

export const create = internalMutation({
  args: {
    externalAppId: v.id("externalApps"), config: vExternalApp, purpose: vProbePurpose,
    caseId: v.optional(v.id("cases")), stepAttemptId: v.optional(v.id("stepAttempts")),
    expectedRevision: v.optional(v.string()), baseline: v.optional(vProbeBaseline),
    transport: v.union(v.literal("github_actions"), v.literal("local_browser")),
    revisionBefore: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"probeRuns">> => {
    const externalApp = await ctx.db.get(args.externalAppId);
    if (!externalApp || externalApp.appId !== args.config.appId) throw new Error("External app not found");
    if (args.caseId) {
      const incident = await ctx.db.get(args.caseId);
      if (!incident || incident.appId !== externalApp.appId) throw new Error("Case belongs to another app");
    }
    if (args.stepAttemptId) {
      const attempt = await ctx.db.get(args.stepAttemptId);
      if (!attempt || !args.caseId || attempt.caseId !== args.caseId) throw new Error("Attempt belongs to another case");
    }
    if (args.expectedRevision && !/^[a-f0-9]{40}$/.test(args.expectedRevision)) throw new Error("Expected revision is malformed");
    if (args.baseline) validateBaseline(args.baseline);
    if (args.caseId && args.stepAttemptId) {
      const existing = await ctx.db.query("probeRuns").withIndex("by_case", (q) => q.eq("caseId", args.caseId)).collect();
      const same = existing.find((run) => run.stepAttemptId === args.stepAttemptId && run.purpose === args.purpose && run.expectedRevision === args.expectedRevision);
      if (same) return same._id;
    }
    if (!Number.isFinite(args.config.probe.timeoutMinutes) || args.config.probe.timeoutMinutes <= 0) throw new Error("Probe timeout must be positive");
    const now = Date.now();
    const deadlineAt = now + Math.min(args.config.probe.timeoutMinutes, 15) * 60_000;
    const probeRunId = await ctx.db.insert("probeRuns", {
      ...args, appId: externalApp.appId, probeId: crypto.randomUUID(), requestedAt: now,
      deadlineAt,
    });
    await ctx.scheduler.runAfter(0, poll, { probeRunId });
    await ctx.scheduler.runAt(deadlineAt, poll, { probeRunId });
    return probeRunId;
  },
});

export const get = internalQuery({
  args: { probeRunId: v.id("probeRuns") },
  handler: (ctx, args) => ctx.db.get(args.probeRunId),
});

export const externalApp = internalQuery({
  args: { externalAppId: v.id("externalApps") },
  handler: (ctx, args) => ctx.db.get(args.externalAppId),
});

export const claimDispatch = internalMutation({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, args): Promise<boolean> => {
    const run = await ctx.db.get(args.probeRunId);
    if (!run || run.completedAt || run.dispatchClaimedAt || run.transport !== "github_actions") return false;
    await ctx.db.patch(run._id, { dispatchClaimedAt: Date.now() });
    return true;
  },
});

export const progress = internalMutation({
  args: {
    probeRunId: v.id("probeRuns"), revisionBefore: v.optional(v.string()),
    dispatchedAt: v.optional(v.number()), githubRunId: v.optional(v.number()),
    githubRunUrl: v.optional(v.string()), probeCodeSha: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, { probeRunId, ...patch }): Promise<void> => {
    const run = await ctx.db.get(probeRunId);
    if (!run || run.completedAt) return;
    if (patch.revisionBefore && run.revisionBefore && patch.revisionBefore !== run.revisionBefore) throw new Error("Initial revision is immutable");
    if (patch.githubRunId && run.githubRunId && patch.githubRunId !== run.githubRunId) throw new Error("Workflow run is immutable");
    await ctx.db.patch(probeRunId, patch);
  },
});

export const schedulePoll = internalMutation({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.db.get(args.probeRunId);
    if (!run || run.completedAt) return;
    await ctx.scheduler.runAfter(Math.max(0, Math.min(15_000, run.deadlineAt - Date.now())), poll, args);
  },
});

export const vStoredScreenshot = v.object({
  file: v.string(), step: v.string(), caption: v.string(), capturedAt: v.number(),
  storageId: v.optional(v.id("_storage")), unavailableReason: v.optional(v.string()),
  pixelWidth: v.optional(v.number()), pixelHeight: v.optional(v.number()),
});

export const complete = internalMutation({
  args: {
    probeRunId: v.id("probeRuns"), outcome: vProbeOutcome, reason: v.string(),
    revisionAfter: v.optional(v.string()), result: v.optional(vProbeResult),
    screenshots: v.array(vStoredScreenshot),
  },
  handler: async (ctx, { probeRunId, screenshots, ...result }): Promise<boolean> => {
    const run = await ctx.db.get(probeRunId);
    if (!run || run.completedAt) return false;
    const completedAt = Date.now();
    const final = completedAt > run.deadlineAt ? { ...result, outcome: "inconclusive" as const, reason: "The probe exceeded its observation deadline." } : result;
    await ctx.db.patch(probeRunId, { ...final, completedAt });
    for (const shot of screenshots) {
      await ctx.db.insert("browserScreenshots", {
        ...shot, appId: run.appId, ...(run.caseId ? { caseId: run.caseId } : {}), probeRunId,
        phase: result.result?.verdict === "failed" ? "failure" : run.purpose === "verify" ? "after" : "before",
        viewport: result.result?.viewport || run.config.probe.viewport,
        commitSha: result.result?.revision || run.revisionBefore || "unknown",
        environment: result.result?.environment || run.config.environment,
        ...(result.result ? { fixture: result.result.fixture } : {}),
        ...(run.githubRunUrl ? { sourceUrl: run.githubRunUrl } : {}),
      });
    }
    await ctx.scheduler.runAfter(0, completed, { probeRunId });
    return true;
  },
});

export const uploadUrl = internalMutation({
  args: {},
  handler: (ctx): Promise<string> => ctx.storage.generateUploadUrl(),
});
