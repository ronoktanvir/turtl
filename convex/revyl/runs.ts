import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query, type ActionCtx } from "../_generated/server";
import { canSeeCase } from "../access";
import {
  TERMINAL_STATUSES,
  failedStep,
  reportContext,
  revylConfig,
  startWorkflow,
  stepScreenshots,
  workflowStatus,
  type ReportContext,
} from "./api";
import { vRevylRunStatus, vScreenshotPhase } from "./schema";

export const POLL_MS = 15_000;
const MAX_RUN_MS = 20 * 60_000;
const MAX_SCREENSHOTS = 8;
const PHASE_ORDER = { failure: 0, before: 1, after: 2 } as const;

type Phase = Infer<typeof vScreenshotPhase>;

export type StartResult =
  | { outcome: "started"; runId: Id<"revylRuns">; taskId: string }
  | { outcome: "not_configured"; missing: string[] }
  | { outcome: "failed"; reason: string };

export async function startRun(
  ctx: ActionCtx,
  args: {
    caseId?: Id<"cases">;
    stepAttemptId?: Id<"stepAttempts">;
    phase: Phase;
    workflowId?: string;
    credentialRef?: string;
  },
): Promise<StartResult> {
  if (args.caseId && args.stepAttemptId) {
    const existing: Doc<"revylRuns"> | null = await ctx.runQuery(internal.revyl.runs.forVerification, {
      caseId: args.caseId, stepAttemptId: args.stepAttemptId, phase: args.phase,
    });
    if (existing) return { outcome: "started", runId: existing._id, taskId: existing.taskId };
  }
  const resolved = revylConfig(args);
  if (!resolved.ok) return { outcome: "not_configured", missing: resolved.missing };
  const started = await startWorkflow(resolved.config);
  if (!started.ok) return { outcome: "failed", reason: started.reason };
  if (!started.body?.task_id) return { outcome: "failed", reason: "Revyl queued the run but returned no task id" };
  const runId: Id<"revylRuns"> = await ctx.runMutation(internal.revyl.runs.create, {
    caseId: args.caseId,
    stepAttemptId: args.stepAttemptId,
    phase: args.phase,
    workflowId: resolved.config.workflowId,
    credentialRef: args.credentialRef,
    taskId: started.body.task_id,
    startedAt: Date.now(),
  });
  return { outcome: "started", runId, taskId: started.body.task_id };
}

function describeRun(status: Infer<typeof vRevylRunStatus>, reports: ReportContext[], fallback: string) {
  const device = reports.find((r) => r.device_model)?.device_model;
  const on = device ? ` on a cloud ${device}` : " on a cloud device";
  const names = reports.map((r) => r.test_name).filter(Boolean).join(", ");
  if (status === "passed") return `The Revyl run passed${on}${names ? `: ${names}` : ""}.`;
  if (status === "failed") {
    const step = reports.map(failedStep).find(Boolean);
    const at = step?.step_description ? ` at "${step.step_description}"` : "";
    const why = step?.error_message || reports.find((r) => r.error_message)?.error_message;
    return `The Revyl run failed${on}${at}${why ? `: ${why}` : "."}`;
  }
  return `The Revyl run did not finish normally: ${fallback}.`;
}

// One look at a run. Returns the finished run, or null while Revyl is still running it.
export async function advanceRun(ctx: ActionCtx, runId: Id<"revylRuns">): Promise<Doc<"revylRuns"> | null> {
  const run: Doc<"revylRuns"> | null = await ctx.runQuery(internal.revyl.runs.get, { runId });
  if (!run) throw new Error("Revyl run not found.");
  if (run.status !== "running") return run;
  const finish = (fields: { status: Infer<typeof vRevylRunStatus>; summary: string; reportUrl?: string }, shots: { storageId: Id<"_storage">; caption: string; takenAt: number }[] = []) =>
    ctx.runMutation(internal.revyl.runs.finish, { runId, ...fields, completedAt: Date.now(), shots });

  const resolved = revylConfig(run);
  if (!resolved.ok) {
    return finish({ status: "error", summary: `Stopped following the Revyl run: ${resolved.missing.join(" and ")} is no longer set.` });
  }
  const status = await workflowStatus(resolved.config, run.taskId);
  if (!status.ok || !TERMINAL_STATUSES.includes(status.body.status)) {
    if (Date.now() - run.startedAt < MAX_RUN_MS) return null;
    const last = status.ok ? `still ${status.body.status}` : status.reason;
    return finish({ status: "error", summary: `Revyl had not finished the run within ${MAX_RUN_MS / 60_000} minutes (${last}).` });
  }

  const body = status.body;
  const reports: ReportContext[] = [];
  for (const child of body.child_tasks ?? []) {
    const report = await reportContext(resolved.config, child.id);
    if (report.ok) reports.push(report.body);
  }
  const failedTests = body.failed_tests ?? (body.child_tasks ?? []).filter((c) => c.success === false).length;
  const passedTests = body.passed_tests ?? (body.child_tasks ?? []).filter((c) => c.success === true).length;
  const verdict =
    failedTests > 0 ? "failed" : body.status === "completed" && passedTests > 0 ? "passed" : "error";

  const all = reports.flatMap(stepScreenshots);
  const kept = all.length > MAX_SCREENSHOTS ? [...all.slice(0, MAX_SCREENSHOTS - 1), all[all.length - 1]] : all;
  const shots = [];
  for (const shot of kept) {
    try {
      const response = await fetch(shot.url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      shots.push({ storageId: await ctx.storage.store(await response.blob()), caption: shot.caption, takenAt: shot.takenAt });
    } catch {
      continue;
    }
  }
  const reportUrl = reports.find((r) => r.report_url)?.report_url ?? undefined;
  const fallback = [body.status, body.error_message].filter(Boolean).join(", ");
  return finish({ status: verdict, summary: describeRun(verdict, reports, fallback), reportUrl }, shots);
}

// Starts a Revyl run of a journey's workflow on a cloud device and follows it in the background until
// its verdict and screenshots are stored. Internal: run it from the backend or with `npx convex run`.
export const start = internalAction({
  args: {
    caseId: v.optional(v.id("cases")),
    phase: vScreenshotPhase,
    workflowId: v.optional(v.string()),
    credentialRef: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<StartResult> => {
    const result = await startRun(ctx, args);
    if (result.outcome === "started") {
      await ctx.scheduler.runAfter(POLL_MS, internal.revyl.runs.follow, { runId: result.runId });
    }
    return result;
  },
});

export const follow = internalAction({
  args: { runId: v.id("revylRuns") },
  handler: async (ctx, { runId }) => {
    const run = await advanceRun(ctx, runId);
    if (!run) await ctx.scheduler.runAfter(POLL_MS, internal.revyl.runs.follow, { runId });
    if (run?.stepAttemptId) {
      const resumed = await ctx.runMutation(internal.runner.run.resumeDeviceVerification, { attemptId: run.stepAttemptId });
      if (resumed === "running") await ctx.scheduler.runAfter(POLL_MS, internal.revyl.runs.follow, { runId });
    }
    return run ? { status: run.status, summary: run.summary } : { status: "running" as const };
  },
});

export const get = internalQuery({
  args: { runId: v.id("revylRuns") },
  handler: (ctx, { runId }) => ctx.db.get(runId),
});

export const forVerification = internalQuery({
  args: { caseId: v.id("cases"), stepAttemptId: v.id("stepAttempts"), phase: vScreenshotPhase },
  handler: async (ctx, { caseId, stepAttemptId, phase }): Promise<Doc<"revylRuns"> | null> => {
    const attempt = await ctx.db.get(stepAttemptId);
    if (!attempt || attempt.caseId !== caseId) throw new Error("The verification attempt does not belong to this case.");
    const runs = await ctx.db.query("revylRuns").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("desc").collect();
    for (const run of runs) {
      if (run.phase !== phase || !run.stepAttemptId) continue;
      if ((await ctx.db.get(run.stepAttemptId))?.stepId === attempt.stepId) return run;
    }
    return null;
  },
});

export const create = internalMutation({
  args: {
    caseId: v.optional(v.id("cases")),
    stepAttemptId: v.optional(v.id("stepAttempts")),
    phase: vScreenshotPhase,
    workflowId: v.string(),
    credentialRef: v.optional(v.string()),
    taskId: v.string(),
    startedAt: v.number(),
  },
  handler: (ctx, args) => ctx.db.insert("revylRuns", { ...args, status: "running" }),
});

export const finish = internalMutation({
  args: {
    runId: v.id("revylRuns"),
    status: vRevylRunStatus,
    summary: v.string(),
    reportUrl: v.optional(v.string()),
    completedAt: v.number(),
    shots: v.array(v.object({ storageId: v.id("_storage"), caption: v.string(), takenAt: v.number() })),
  },
  handler: async (ctx, { runId, shots, ...fields }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Revyl run not found.");
    if (run.status !== "running") {
      for (const shot of shots) await ctx.storage.delete(shot.storageId);
      return run;
    }
    for (const shot of shots) {
      await ctx.db.insert("revylScreenshots", { runId, caseId: run.caseId, phase: run.phase, ...shot });
    }
    await ctx.db.patch(runId, fields);
    return { ...run, ...fields };
  },
});

// A case's screenshots from the app, in the UI contract's Screenshot shape: failure, then before, then after.
export const screenshots = query({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    if (!(await canSeeCase(ctx, caseId))) return [];
    const rows = await ctx.db
      .query("revylScreenshots")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    rows.sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.takenAt - b.takenAt);
    const shots = [];
    for (const row of rows) {
      const url = await ctx.storage.getUrl(row.storageId);
      if (url) shots.push({ id: row._id as string, url, caption: row.caption, phase: row.phase, takenAt: row.takenAt });
    }
    return shots;
  },
});
