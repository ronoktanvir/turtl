import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { extractArtifact } from "./artifacts";
import { credential, dispatchWorkflow, downloadArtifact, findWorkflowRun, MAX_ARCHIVE_BYTES, readRevision } from "./probeClient";
import { vStoredScreenshot } from "./probeRecords";
import { evaluateProbe, vProbeBaseline, vProbePurpose, type ProbeBaseline, type ProbePurpose } from "./validators";

export { readRevision, readDiagnostics } from "./probeClient";

export type StartProbeArgs = {
  externalApp: Doc<"externalApps">;
  purpose: ProbePurpose;
  caseId?: Id<"cases">;
  stepAttemptId?: Id<"stepAttempts">;
  expectedRevision?: string;
  baseline?: ProbeBaseline;
};

export async function startProbe(ctx: ActionCtx, { externalApp, ...args }: StartProbeArgs): Promise<Id<"probeRuns">> {
  const { _id, _creationTime, ...config } = externalApp;
  const transport = config.probe.transport || "github_actions";
  let revisionBefore: string | undefined;
  if (transport === "local_browser") {
    const revision = await readRevision(config);
    if (revision.ok) revisionBefore = revision.body.revision;
  }
  const probeRunId: Id<"probeRuns"> = await ctx.runMutation(internal.externalApp.probeRecords.create, {
    ...args, externalAppId: _id, config, transport, ...(revisionBefore ? { revisionBefore } : {}),
  });
  if (transport === "local_browser" && !revisionBefore) await settleUnavailable(ctx, probeRunId, "The deployed revision is unavailable before the local browser run.");
  return probeRunId;
}

async function settleUnavailable(ctx: ActionCtx, probeRunId: Id<"probeRuns">, reason: string): Promise<void> {
  await ctx.runMutation(internal.externalApp.probeRecords.complete, { probeRunId, outcome: "inconclusive", reason, screenshots: [] });
}

async function ingestBytes(ctx: ActionCtx, run: Doc<"probeRuns">, bytes: Uint8Array): Promise<void> {
  const { result, screenshots } = extractArtifact(bytes);
  const after = await readRevision(run.config);
  const evaluation = evaluateProbe({
    config: run.config, probeId: run.probeId, purpose: run.purpose, revisionBefore: run.revisionBefore,
    ...(after.ok ? { revisionAfter: after.body.revision } : {}),
    ...(run.expectedRevision ? { expectedRevision: run.expectedRevision } : {}),
    ...(run.baseline ? { baseline: run.baseline } : {}), result,
  });
  if (result.startedAt < run.requestedAt - 60_000 || result.completedAt > Date.now() + 60_000) {
    evaluation.outcome = "inconclusive";
    evaluation.reason = "Browser timestamps do not belong to this observation window.";
  }
  const stored: Infer<typeof vStoredScreenshot>[] = [];
  const storageIds: Id<"_storage">[] = [];
  try {
    for (const { bytes: png, ...shot } of screenshots) {
      if (!png) { stored.push(shot); continue; }
      try {
        const storageId = await ctx.storage.store(new Blob([new Uint8Array(png)], { type: "image/png" }));
        storageIds.push(storageId);
        stored.push({ ...shot, storageId });
      } catch {
        stored.push({ ...shot, unavailableReason: "The browser screenshot could not be stored." });
      }
    }
    const accepted: boolean = await ctx.runMutation(internal.externalApp.probeRecords.complete, {
      probeRunId: run._id, ...evaluation, result, screenshots: stored,
      ...(after.ok ? { revisionAfter: after.body.revision } : {}),
    });
    if (accepted) return;
  } catch (error) {
    await Promise.all(storageIds.map((storageId) => ctx.storage.delete(storageId)));
    throw error;
  }
  await Promise.all(storageIds.map((storageId) => ctx.storage.delete(storageId)));
}

export const poll = internalAction({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, { probeRunId }): Promise<void> => {
    const run: Doc<"probeRuns"> | null = await ctx.runQuery(internal.externalApp.probeRecords.get, { probeRunId });
    if (!run || run.completedAt) return;
    if (Date.now() >= run.deadlineAt) {
      await settleUnavailable(ctx, probeRunId, "The gameplay probe did not finish before its deadline (at most 15 minutes).");
      return;
    }
    if (run.transport === "local_browser") {
      await ctx.runMutation(internal.externalApp.probeRecords.schedulePoll, { probeRunId });
      return;
    }
    if (run.config.isTestDouble) {
      await settleUnavailable(ctx, probeRunId, "Test doubles cannot establish gameplay proof.");
      return;
    }
    if (!run.dispatchedAt) {
      const claimed: boolean = await ctx.runMutation(internal.externalApp.probeRecords.claimDispatch, { probeRunId });
      if (!claimed) {
        await settleUnavailable(ctx, probeRunId, "Probe dispatch was interrupted; no duplicate workflow was dispatched.");
        return;
      }
      const before = await readRevision(run.config);
      if (!before.ok) { await settleUnavailable(ctx, probeRunId, before.message); return; }
      if (run.expectedRevision && before.body.revision !== run.expectedRevision) {
        await settleUnavailable(ctx, probeRunId, "The expected deployed revision is not running.");
        return;
      }
      await ctx.runMutation(internal.externalApp.probeRecords.progress, { probeRunId, revisionBefore: before.body.revision });
      try {
        await dispatchWorkflow(run.config, run.probeId);
      } catch {
        await settleUnavailable(ctx, probeRunId, "GitHub workflow dispatch was unavailable or its delivery was uncertain.");
        return;
      }
      await ctx.runMutation(internal.externalApp.probeRecords.progress, { probeRunId, dispatchedAt: Date.now() });
      await ctx.runMutation(internal.externalApp.probeRecords.schedulePoll, { probeRunId });
      return;
    }
    if (!credential(run.config.githubCredentialRef)) {
      await settleUnavailable(ctx, probeRunId, "The configured GitHub credential is unavailable.");
      return;
    }
    try {
      const workflow = await findWorkflowRun(run.config, run.probeId, run.requestedAt);
      if (!workflow) {
        await ctx.runMutation(internal.externalApp.probeRecords.schedulePoll, { probeRunId });
        return;
      }
      await ctx.runMutation(internal.externalApp.probeRecords.progress, {
        probeRunId, githubRunId: workflow.id, githubRunUrl: workflow.html_url, probeCodeSha: workflow.head_sha,
      });
      if (workflow.status !== "completed") {
        await ctx.runMutation(internal.externalApp.probeRecords.schedulePoll, { probeRunId });
        return;
      }
      const bytes = await downloadArtifact(run.config, workflow.id, run.probeId);
      await ingestBytes(ctx, { ...run, githubRunUrl: workflow.html_url }, bytes);
    } catch {
      await settleUnavailable(ctx, probeRunId, "The workflow run, result artifact or browser result was unavailable or malformed.");
    }
  },
});

export const startLocalProbe = internalAction({
  args: {
    externalAppId: v.id("externalApps"), purpose: vProbePurpose,
    caseId: v.optional(v.id("cases")), stepAttemptId: v.optional(v.id("stepAttempts")),
    expectedRevision: v.optional(v.string()), baseline: v.optional(vProbeBaseline),
  },
  handler: async (ctx, { externalAppId, ...args }): Promise<Id<"probeRuns">> => {
    const externalApp: Doc<"externalApps"> | null = await ctx.runQuery(internal.externalApp.probeRecords.externalApp, { externalAppId });
    if (!externalApp || externalApp.probe.transport !== "local_browser") throw new Error("The app is not registered for recorded local browser transport");
    return startProbe(ctx, { externalApp, ...args });
  },
});

export const ingestArtifact = internalAction({
  args: { probeRunId: v.id("probeRuns"), storageId: v.id("_storage") },
  handler: async (ctx, { probeRunId, storageId }): Promise<void> => {
    const run: Doc<"probeRuns"> | null = await ctx.runQuery(internal.externalApp.probeRecords.get, { probeRunId });
    if (!run || run.completedAt) return;
    if (run.transport !== "local_browser") throw new Error("Local artifact ingestion is not enabled for this run");
    if (Date.now() >= run.deadlineAt) { await settleUnavailable(ctx, probeRunId, "The local browser probe exceeded its deadline."); return; }
    try {
      const blob = await ctx.storage.get(storageId);
      if (!blob || blob.size > MAX_ARCHIVE_BYTES) throw new Error("Missing or oversized archive");
      await ingestBytes(ctx, run, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      await settleUnavailable(ctx, probeRunId, "The stored local browser artifact is unavailable or malformed.");
    }
  },
});
