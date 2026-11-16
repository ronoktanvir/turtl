import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_ATTEMPTS } from "../workflow";

// What the case's workflow is doing right now, for the case chat's "what are you doing / stuck on" answers:
// the steps running or waiting, what each waits for, the steps that cannot start yet, and the last error.

type Step = Doc<"steps"> & { currentAttempt: Doc<"stepAttempts"> | null };

const span = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
};

export function describeWork(
  caseStatus: Doc<"cases">["status"],
  steps: Step[],
  attempts: Doc<"stepAttempts">[],
  now: number,
) {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const titleOf = new Map(steps.map((step) => [step._id as string, step.title]));
  const active = steps
    .filter((step) => step.status === "running" || step.status === "waiting")
    .map((step) => {
      const attempt = step.currentAttempt;
      const waitingFor = step.status === "running"
        ? "its own work to finish; no result has come back yet"
        : step.purpose === "authorize_and_execute" && caseStatus === "waiting_for_owner"
          ? "the owner's decision: Approve on a fix, behind the passcode"
          : caseStatus === "waiting_for_deploy"
            ? "the change to be deployed"
            : "a result from outside turtl";
      return {
        step: step.title,
        status: step.status,
        attempt: attempt?.attempt ?? null,
        maxAttempts: MAX_ATTEMPTS,
        runningFor: attempt?.startedAt ? span(now - attempt.startedAt) : null,
        waitingFor,
        latestNote: attempt?.summary ?? null,
      };
    });
  const blocked = steps
    .filter((step) => step.status === "pending")
    .map((step) => ({
      step: step.title,
      waitingOn: step.dependsOn
        .map((key) => byKey.get(key))
        .filter((parent): parent is Step => !!parent && parent.status !== "done" && parent.status !== "skipped")
        .map((parent) => parent.title),
    }))
    .slice(0, 3);
  const failure = attempts
    .filter((attempt) => attempt.error)
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? b._creationTime) - (a.finishedAt ?? a.startedAt ?? a._creationTime))[0];
  const failedStep = failure ? steps.find((step) => step._id === failure.stepId) : undefined;
  const failed = steps.filter((step) => step.status === "failed");
  const stepsDone = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  const headline = active[0]
    ? `${active[0].step} is ${active[0].status === "running" ? "running" : "waiting"}${active[0].attempt ? ` (attempt ${active[0].attempt} of ${MAX_ATTEMPTS}${active[0].runningFor ? `, for ${active[0].runningFor}` : ""})` : ""}, waiting for ${active[0].waitingFor}.`
    : failed.length
      ? `Nothing is running. ${failed.map((step) => (step.currentAttempt?.attempt ?? 0) >= MAX_ATTEMPTS ? `${step.title} failed on its last attempt and will not run again on its own` : `${step.title} failed and will be retried`).join("; ")}.`
      : stepsDone === steps.length ? "Nothing is running. Every step has finished." : "Nothing is running right now.";
  return {
    now: headline,
    caseStatus,
    stepsDone,
    stepsTotal: steps.length,
    active,
    blocked,
    failedSteps: failed.map((step) => step.title),
    lastError: failure
      ? {
          step: titleOf.get(failure.stepId) ?? "a step",
          attempt: failure.attempt,
          error: failure.error!,
          ago: span(now - (failure.finishedAt ?? failure.startedAt ?? failure._creationTime)),
          stillCurrent: failedStep?.currentAttemptId === failure._id,
          lateResult: !!failure.lateResultAt,
        }
      : null,
  };
}

export async function caseWork(ctx: QueryCtx, row: Doc<"cases">, steps: Step[]) {
  const attempts = await ctx.db
    .query("stepAttempts")
    .withIndex("by_case", (q) => q.eq("caseId", row._id))
    .collect();
  return describeWork(row.status, steps, attempts, Date.now());
}
