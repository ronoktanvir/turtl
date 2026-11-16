import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { CLOSED_CASE_STATUSES } from "../constants";
import { BOOKING_APP_NAME } from "../protectedApp/registry";
import { setCaseStatus } from "../workflow";

declare const process: { env: Record<string, string | undefined> };

function requireDev() {
  if (process.env.DEV_TOOLS_ENABLED !== "true")
    throw new Error("Dev tools are disabled on this deployment.");
}

async function bookingCases(ctx: MutationCtx, appId: Id<"apps">) {
  const app = await ctx.db.get(appId);
  if (!app || app.name !== BOOKING_APP_NAME || !app.productionUrl)
    throw new Error("Register the booking demo before resetting it.");
  const cases = (
    await ctx.db
      .query("cases")
      .withIndex("by_app_and_signature", (q) => q.eq("appId", appId))
      .collect()
  ).filter((row) => row.journeyId !== undefined);
  for (const row of cases) {
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_case", (q) => q.eq("caseId", row._id))
      .collect();
    if (
      actions.some(
        (action) => action.status === "running" || action.status === "unknown",
      )
    )
      throw new Error(
        "Wait for the running or unreconciled booking action to finish before resetting its history.",
      );
    for (const action of actions)
      if (action.status === "pending")
        await ctx.db.patch(action._id, {
          status: "cancelled",
          completedAt: Date.now(),
          result: "Cancelled by the booking demo reset before execution.",
        });
  }
  return { app, cases };
}

async function cancelCaseJobs(
  ctx: MutationCtx,
  caseIds: Set<string>,
  attemptIds: Set<string>,
  runIds: Set<string>,
) {
  const jobs = await ctx.db.system.query("_scheduled_functions").collect();
  let cancelled = 0;
  for (const job of jobs) {
    const args = job.args[0] as
      | { caseId?: string; attemptId?: string; runId?: string }
      | undefined;
    if (
      job.state.kind === "pending" &&
      ((args?.caseId && caseIds.has(args.caseId)) ||
        (args?.attemptId && attemptIds.has(args.attemptId)) ||
        (args?.runId && runIds.has(args.runId)))
    ) {
      await ctx.scheduler.cancel(job._id);
      cancelled++;
    }
  }
  return cancelled;
}

export const prepare = internalMutation({
  args: {},
  handler: async (ctx) => {
    requireDev();
    const app = await ctx.db
      .query("apps")
      .filter((q) => q.eq(q.field("name"), BOOKING_APP_NAME))
      .first();
    if (!app) throw new Error("Register the booking demo before resetting it.");
    const scope = await bookingCases(ctx, app._id);
    const journeys = await ctx.db
      .query("journeys")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .collect();
    if (!journeys.length)
      throw new Error("Register the booking journey before resetting it.");
    const attemptIds = new Set<string>();
    const runIds = new Set<string>();
    for (const row of scope.cases) {
      for (const attempt of await ctx.db
        .query("stepAttempts")
        .withIndex("by_case", (q) => q.eq("caseId", row._id))
        .collect())
        attemptIds.add(attempt._id);
      for (const run of await ctx.db
        .query("revylRuns")
        .withIndex("by_case", (q) => q.eq("caseId", row._id))
        .collect())
        runIds.add(run._id);
      if (!(CLOSED_CASE_STATUSES as readonly string[]).includes(row.status))
        await setCaseStatus(ctx, row._id, "declined");
    }
    const cancelledScheduled = await cancelCaseJobs(
      ctx,
      new Set(scope.cases.map((row) => row._id)),
      attemptIds,
      runIds,
    );
    const permissions = await ctx.db
      .query("permissions")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .collect();
    for (const permission of permissions) await ctx.db.delete(permission._id);
    for (const journey of journeys)
      await ctx.db.patch(journey._id, { lastPassedAt: undefined });
    return {
      appId: app._id,
      caseIds: scope.cases.map((row) => row._id),
      base: scope.app.productionUrl!,
      journeys,
      permissionsDeleted: permissions.length,
      cancelledScheduled,
    };
  },
});

export const clear = internalMutation({
  args: {
    appId: v.id("apps"),
    caseIds: v.array(v.id("cases")),
    passedJourneys: v.array(
      v.object({ journeyId: v.id("journeys"), observedAt: v.number() }),
    ),
  },
  handler: async (ctx, { appId, caseIds, passedJourneys }) => {
    requireDev();
    const { cases } = await bookingCases(ctx, appId);
    const prepared = new Set(caseIds);
    if (cases.some((row) => !prepared.has(row._id)))
      throw new Error(
        "A new booking incident arrived during reset. Its history was kept; review it before retrying.",
      );
    const counts = {
      cases: cases.length,
      steps: 0,
      stepAttempts: 0,
      evidence: 0,
      proposals: 0,
      actions: 0,
      verifications: 0,
      agentRuns: 0,
      recoveryMemories: 0,
      permissions: 0,
      ownerNotices: 0,
      pullRequests: 0,
      fixChatMessages: 0,
      revylRuns: 0,
      revylScreenshots: 0,
      screenshotBlobs: 0,
      cancelledScheduled: 0,
    };
    const attemptIds = new Set<string>();
    const runIds = new Set<string>();
    const screenshotIds = new Set<Id<"_storage">>();
    for (const row of cases) {
      const notices = await ctx.db
        .query("ownerNotices")
        .withIndex("by_case_and_event", (q) => q.eq("caseId", row._id))
        .collect();
      for (const notice of notices) {
        await ctx.db.delete(notice._id);
        counts.ownerNotices++;
      }
      for (const table of [
        "evidence",
        "proposals",
        "actions",
        "verifications",
        "agentRuns",
        "stepAttempts",
        "steps",
        "pullRequests",
        "fixChatMessages",
        "revylRuns",
        "revylScreenshots",
      ] as const) {
        const children = await ctx.db
          .query(table)
          .withIndex("by_case", (q) => q.eq("caseId", row._id))
          .collect();
        for (const child of children) {
          if (table === "stepAttempts") attemptIds.add(child._id);
          if (table === "revylRuns") runIds.add(child._id);
          if ("storageId" in child) screenshotIds.add(child.storageId);
          await ctx.db.delete(child._id);
          counts[table]++;
        }
      }
      await ctx.db.delete(row._id);
    }
    for (const storageId of screenshotIds) {
      await ctx.storage.delete(storageId);
      counts.screenshotBlobs++;
    }
    counts.cancelledScheduled = await cancelCaseJobs(
      ctx,
      new Set(cases.map((row) => row._id)),
      attemptIds,
      runIds,
    );
    const memories = await ctx.db
      .query("recoveryMemories")
      .withIndex("by_app_and_signature", (q) => q.eq("appId", appId))
      .collect();
    for (const memory of memories) {
      await ctx.db.delete(memory._id);
      counts.recoveryMemories++;
    }
    const permissions = await ctx.db
      .query("permissions")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    for (const permission of permissions) {
      await ctx.db.delete(permission._id);
      counts.permissions++;
    }
    const journeys = await ctx.db
      .query("journeys")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    const passed = new Map(
      passedJourneys.map((pass) => [pass.journeyId, pass.observedAt]),
    );
    if (
      passedJourneys.some(
        (pass) => !journeys.some((journey) => journey._id === pass.journeyId),
      )
    )
      throw new Error("The passing check does not belong to the booking demo.");
    for (const journey of journeys)
      await ctx.db.patch(journey._id, {
        lastPassedAt: passed.has(journey._id)
          ? Math.max(journey.lastPassedAt ?? 0, passed.get(journey._id)!)
          : undefined,
      });
    return counts;
  },
});
