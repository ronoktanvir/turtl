import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { POLL_MS, advanceRun, startRun } from "./runs";

export const DEVICE_WAIT_MS = 6 * 60_000;

export type DeviceCheck = {
  status: "passed" | "failed" | "uncovered";
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
  return { status: "uncovered", summary: `Not covered: ${summary}`, evidence };
}

// The device criterion for the verify step: runs the booking journey's Revyl workflow on a cloud device
// and waits for it. Covered only by a Revyl run that really finished; otherwise uncovered, saying why.
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
  const deadline = Date.now() + DEVICE_WAIT_MS;
  for (;;) {
    const run = await advanceRun(ctx, started.runId);
    if (run) return fromRun(run);
    if (Date.now() + POLL_MS > deadline) {
      await ctx.scheduler.runAfter(POLL_MS, internal.revyl.runs.follow, { runId: started.runId });
      return {
        status: "uncovered",
        summary: `Not covered: the Revyl run of the booking screen (run ${started.taskId}) had not finished within ${DEVICE_WAIT_MS / 60_000} minutes, so it is not counted. Its screenshots are added to the case when it finishes.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
