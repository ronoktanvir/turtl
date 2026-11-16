import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { HandlerInput, HandlerResult } from "../runner/contract";
import type { CaseContext, Facts } from "../runner/handlers/journey";
import { readDiagnostics, readRevision, startProbe } from "./probes";
import { readSource } from "./source";
import { completeVerification } from "./repair";
import { syncAgentEvidence } from "./agent";

declare const process: { env: Record<string, string | undefined> };

export async function gather(ctx: ActionCtx, input: HandlerInput, app: Doc<"externalApps">): Promise<HandlerResult> {
  await ctx.runMutation(internal.externalApp.records.holdClock, { attemptId: input.attempt._id });
  const probeRunId = await startProbe(ctx, { externalApp: app, purpose: "reproduce", caseId: input.case._id, stepAttemptId: input.attempt._id });
  return { status: "waiting", summary: "A real browser gameplay reproduction is running. No answer request has been verified yet.", externalRef: `probeRuns/${probeRunId}` };
}

async function finishGather(ctx: ActionCtx, run: Doc<"probeRuns">, app: Doc<"externalApps">) {
  if (!run.caseId || !run.stepAttemptId) return;
  const loaded = await ctx.runQuery(internal.runner.run.loadInput, { attemptId: run.stepAttemptId });
  if (!loaded) return;
  const input: HandlerInput = { ...loaded, idempotencyKey: loaded.step._id, approval: null };
  if (!run.result || run.outcome === "inconclusive") {
    await ctx.runMutation(internal.runner.run.recordResult, { attemptId: run.stepAttemptId, result: { status: "failed", error: `Gameplay reproduction is inconclusive: ${run.reason ?? "no readable browser result"}. Nothing was diagnosed or repaired.` } });
    return;
  }
  const result = run.result;
  const [diagnostics, source, revision] = await Promise.all([readDiagnostics(app), readSource(app, result.revision), readRevision(app)]);
  const revisionStable = revision.ok && revision.body.revision === result.revision && revision.body.environment === app.environment;
  const facts: Facts = {
    "app.revision": result.revision, "journey.verdict": run.outcome ?? "inconclusive", "journey.failedStep": result.failedStep ?? "none", "journey.errorCode": result.error?.code ?? "none",
    "gameplay.deadlineMs": result.deadlineMs ?? 0, "source.filesRead": source.files.length, "source.revisionStable": revisionStable,
  };
  if (result.fixture) { facts["fixture.id"] = result.fixture.id; facts["fixture.scoreCount"] = result.fixture.scoreCount; }
  const request = result.steps.find((step) => step.request?.method === "POST" && step.request.path === "/api/answer");
  if (request?.request) { facts["answer.durationMs"] = request.request.durationMs; facts["answer.outcome"] = request.request.outcome; }
  const rows = [{
    kind: "journey_check", title: `Browser gameplay ${run.outcome}: ${result.failedStep ?? "all required criteria"}.`,
    body: JSON.stringify(result), sourceRef: `probeRuns/${run._id}`,
  }, ...source.files.map((file) => ({ kind: "code", title: `${file.path} at running revision ${result.revision}`, body: file.source, sourceRef: file.url })), {
    kind: "diagnostics", title: diagnostics.ok ? "Sanitized gameplay diagnostics read from the game." : "Diagnostics unavailable.",
    body: diagnostics.ok ? JSON.stringify(diagnostics.body) : diagnostics.message, sourceRef: app.diagnostics?.path ?? "diagnostics not configured",
  }, { kind: "revision", title: `Gameplay ran at ${result.revision}.`, body: revisionStable ? "The deployed revision still matches the browser run." : "The deployment changed or could not be read after source gathering.", sourceRef: app.revisionPath }];
  if (source.missing.length) rows.push({ kind: "unavailable", title: "Some source evidence is unavailable.", body: source.missing.join("\n"), sourceRef: "GitHub source" });
  const evidenceIds: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, { rows: rows.map((row) => ({ ...row, caseId: input.case._id, stepId: input.step._id, stepAttemptId: input.attempt._id, observedAt: Date.now(), environment: app.environment, revision: { commitSha: result.revision } })) });
  if (!revisionStable) {
    await ctx.runMutation(internal.runner.run.recordResult, { attemptId: run.stepAttemptId, result: { status: "failed", error: "The game revision changed during evidence gathering. Reproduction must be repeated; no cause was assumed." } });
    return;
  }
  await ctx.runMutation(internal.runner.run.recordResult, { attemptId: run.stepAttemptId, result: {
    status: "done", summary: `Gameplay ${run.outcome} at ${result.revision}; read ${source.files.length} source files at that exact revision. ${diagnostics.ok ? "Diagnostics are attached." : "Diagnostics unavailable."}`,
    handoff: { note: "Observed gameplay, code and diagnostics are separate evidence; no repair has run.", refs: evidenceIds.map((id) => ({ kind: "evidence", id })) },
    output: { facts, probeRunId: run._id, evidenceIds },
  } });
}

export const probeCompleted = internalAction({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, { probeRunId }): Promise<void> => {
    const loaded = await ctx.runQuery(internal.externalApp.records.probe, { probeRunId });
    if (!loaded?.app || !loaded.run.completedAt) return;
    const { run, app } = loaded;
    if (run.purpose === "monitor") {
      if (run.outcome === "failed") await ctx.runMutation(internal.externalApp.records.openFromProbe, { probeRunId });
      else if (run.outcome === "passed") await ctx.runMutation(internal.monitor.recordPass, { journeyId: app.journeyId, observedAt: run.completedAt! });
    } else if (run.purpose === "reproduce") await finishGather(ctx, run, app);
    else await completeVerification(ctx, probeRunId);
  },
});

export async function checkExternalApps(ctx: ActionCtx): Promise<Id<"journeys">[]> {
  const registered = await ctx.runQuery(internal.externalApp.records.all, {});
  const excluded = registered.map(({ app }: { app: Doc<"externalApps"> }) => app.journeyId);
  if (process.env.EXTERNAL_APPS_ENABLED !== "true") return excluded;
  for (const { app, probes } of registered) {
    if (app.isTestDouble || app.probe.transport === "local_browser") continue;
    if (!probes.some((run: Doc<"probeRuns">) => !run.completedAt)) await startProbe(ctx, { externalApp: app, purpose: "monitor" });
    const pulls: Doc<"pullRequests">[] = await ctx.runQuery(internal.externalApp.records.pullRequests, { appId: app.appId });
    for (const pull of pulls) await syncAgentEvidence(ctx, pull._id);
  }
  return excluded;
}

export const context = async (ctx: ActionCtx, input: HandlerInput): Promise<CaseContext> => ctx.runQuery(internal.protectedApp.records.caseContext, { caseId: input.case._id });
