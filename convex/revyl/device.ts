import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { POLL_MS, advanceRun, startRun } from "./runs";

export type DeviceCheck = {
  status: "passed" | "failed" | "uncovered" | "waiting";
  summary: string;
  evidence?: { kind: string; title: string; sourceRef: string };
};

function fromRun(run: Doc<"revylRuns">): DeviceCheck {
  const summary = run.summary ?? "The Revyl run finished without a summary.";
  const evidence = {
    kind: "revyl_run",
    title: summary,
    sourceRef: `Revyl workflow ${run.workflowId}, run ${run.taskId}${run.reportUrl ? `, report ${run.reportUrl}` : ""}`,
  };
  if (run.status === "passed" || run.status === "failed") return { status: run.status, summary, evidence };
  return { status: "failed", summary: `Device verification did not finish successfully: ${summary}`, evidence };
}

export async function checkBookingScreen(
  ctx: ActionCtx,
  args: { caseId: Id<"cases">; stepAttemptId: Id<"stepAttempts"> },
): Promise<DeviceCheck> {
  const started = await startRun(ctx, { ...args, phase: "after" });
  if (started.outcome === "not_configured") {
    const names = started.missing.join(" and ");
    return {
      status: "uncovered",
      summary: `Not covered: ${names} ${started.missing.length > 1 ? "are" : "is"} not set on this deployment, so no Revyl run of the booking screen happened.`,
    };
  }
  if (started.outcome === "failed") {
    return { status: "uncovered", summary: `Not covered: the Revyl run could not be started (${started.reason}).` };
  }
  const run = await advanceRun(ctx, started.runId);
  if (run) return fromRun(run);
  await ctx.scheduler.runAfter(POLL_MS, internal.revyl.runs.follow, { runId: started.runId });
  return {
    status: "waiting",
    summary: `Waiting for the actual verdict of Revyl run ${started.taskId}; a queued or running device check is not a verified recovery.`,
    evidence: { kind: "revyl_run", title: "Waiting for the device run", sourceRef: `Revyl run ${started.taskId}` },
  };
}
