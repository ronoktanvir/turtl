import type { DocumentByName, SystemDataModel } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type Job = DocumentByName<SystemDataModel, "_scheduled_functions">;

// The scheduled jobs a step attempt waits on (its run and its time limit), kept on the attempt so they can be
// cancelled by id. Stop, the runner's verify step and a pull request's wait cancel through here. They used to read
// the whole _scheduled_functions table, which every account's work adds to (a customer report alone schedules its
// triage), so past Convex's per-mutation read limit those reads would fail for everyone.

/** Job ids kept per attempt. Each dispatch adds two (the run and its time limit); older ones have finished. */
const MAX_JOBS_PER_ATTEMPT = 8;

/** For an attempt dispatched before job ids were kept: how far back its time limit can have been scheduled, and
 * how many jobs of that window are read at most. Remove once no such attempt can still be waiting. */
const LEGACY_LOOKBACK_MS = 15 * 60_000;
const LEGACY_SCAN = 1_000;

export async function rememberJobs(ctx: MutationCtx, attemptId: Id<"stepAttempts">, jobs: Id<"_scheduled_functions">[]) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt) return;
  await ctx.db.patch(attemptId, { scheduledJobs: [...(attempt.scheduledJobs ?? []), ...jobs].slice(-MAX_JOBS_PER_ATTEMPT) });
}

/** Cancels the attempt's jobs that have not started yet; with `only`, just the jobs of that function (e.g. "checkTimeout"). */
export async function cancelJobs(ctx: MutationCtx, attempt: Doc<"stepAttempts"> | null, only?: string) {
  if (!attempt) return;
  const wanted = (job: Job | null) => job?.state.kind === "pending" && (only === undefined || job.name.endsWith(only));
  if (attempt.scheduledJobs) {
    for (const id of attempt.scheduledJobs) if (wanted(await ctx.db.system.get(id))) await ctx.scheduler.cancel(id);
    return;
  }
  const recent = await ctx.db.system
    .query("_scheduled_functions")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", Date.now() - LEGACY_LOOKBACK_MS))
    .order("desc")
    .take(LEGACY_SCAN);
  for (const job of recent) {
    const args = job.args[0] as { attemptId?: string } | undefined;
    if (args?.attemptId === attempt._id && wanted(job)) await ctx.scheduler.cancel(job._id);
  }
}
