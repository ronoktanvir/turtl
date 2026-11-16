import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { devToolsEnabled, requireDevTools } from "./access";
import { CASE_KINDS, CLOSED_CASE_STATUSES, STAGES } from "./constants";
import type { CaseKind, CaseStatus, RaisedBy } from "./constants";
import {
  createCaseFromTemplate,
  finishAttempt,
  loadSteps,
  MAX_ATTEMPTS,
  startAttempt,
} from "./workflow";
import { approveCase, declineCase, startCaseRun } from "./runner/run";
import { checkJourneys, type MonitorResult } from "./monitor";
import { CREDENTIAL_REF, call, controlBase, describeFailure, runJourneyCheck } from "./protectedApp/client";
import { latestProposal } from "./protectedApp/records";
import { BOOKING_APP_NAME, registerBookingApp } from "./protectedApp/registry";

// Dev tools. They open only with DEV_TOOLS_ENABLED=true on the single-owner demo; with accounts on
// (AUTH_REQUIRED=true) they stay closed whatever that flag says (convex/access.ts).

const AUTO_RUN_INTERVAL_MS = 1200;
const AUTO_RUN_STAGGER_MS = 400;

const SAMPLE_APP = { name: "Sample booking app", isSample: true };

const LIVE_APP_NAME = "Live run app (dev)";
const LIVE_STAGED_STEP = "gather_context";
const LIVE_STAGINGS = {
  retry: { fail: 1 },
  timeout: { hang: 1 },
  unresolved: { fail: MAX_ATTEMPTS },
};

const SAMPLES: Record<
  CaseKind,
  { title: string; impact: string; raisedBy: RaisedBy; raisedByRef: string }
> = {
  outage: {
    title: "Customers can't complete bookings",
    impact: "Nobody can book an appointment right now.",
    raisedBy: "monitor",
    raisedByRef: "booking-flow-check",
  },
  bug_report: {
    title: "The confirmation email shows the wrong time",
    impact: "Some customers may show up at the wrong time.",
    raisedBy: "customer",
    raisedByRef: "a customer",
  },
  feature_request: {
    title: "Let customers reschedule a booking",
    impact: "Customers have to cancel and book again to change a time.",
    raisedBy: "customer",
    raisedByRef: "a customer",
  },
};

const requireSampleCase = async (ctx: QueryCtx, caseId: Id<"cases">) => {
  const row = await ctx.db.get(caseId);
  if (!row?.isSample) {
    throw new Error(`Case ${caseId} is not a sample case, so dev tools will not change it.`);
  }
};

const isClosed = (status: CaseStatus) =>
  (CLOSED_CASE_STATUSES as readonly string[]).includes(status);

const sampleApps = (ctx: QueryCtx) =>
  ctx.db.query("apps").withIndex("by_isSample", (q) => q.eq("isSample", true));

const sampleCases = (ctx: QueryCtx) =>
  ctx.db.query("cases").withIndex("by_isSample", (q) => q.eq("isSample", true));

const advanceOnce = async (
  ctx: MutationCtx,
  caseId: Id<"cases">,
): Promise<CaseStatus | null> => {
  const sampleCase = await ctx.db.get(caseId);
  if (!sampleCase) return null;
  if (isClosed(sampleCase.status)) return sampleCase.status;

  const steps = await loadSteps(ctx, caseId);
  const done = (status: string) => status === "done" || status === "skipped";
  const running = steps.find((step) => step.status === "running");

  if (running) {
    const stage = STAGES.find((s) => s.id === running.purpose);
    await finishAttempt(ctx, running.currentAttemptId!, {
      status: "done",
      summary: `Sample: ${(stage?.label ?? running.title).toLowerCase()}.`,
      handoff: `Sample handoff from ${running.key}.`,
    });
    if (steps.every((step) => step._id === running._id || done(step.status))) {
      await ctx.db.patch(caseId, { status: "resolved", resolvedAt: Date.now() });
      return "resolved";
    }
    return sampleCase.status;
  }

  const next = steps.find(
    (step) =>
      step.status === "pending" &&
      step.dependsOn.every((key) => done(steps.find((s) => s.key === key)?.status ?? "")),
  );
  if (!next) {
    throw new Error("No step can run: every remaining step is blocked or failed.");
  }
  await startAttempt(ctx, next._id);
  const status: CaseStatus =
    next.purpose === "authorize_and_execute"
      ? "executing"
      : next.purpose === "verify"
        ? "verifying"
        : next.purpose === "learn"
          ? sampleCase.status
          : "investigating";
  await ctx.db.patch(caseId, { status });
  return status;
};

export const createSampleCases = mutation({
  args: {},
  handler: async (ctx) => {
    requireDevTools();
    const existing = await sampleApps(ctx).first();
    const appId = existing?._id ?? (await ctx.db.insert("apps", SAMPLE_APP));
    const caseIds: Id<"cases">[] = [];
    for (const kind of CASE_KINDS) {
      const sample = SAMPLES[kind.id];
      caseIds.push(
        await createCaseFromTemplate(ctx, {
          appId,
          kind: kind.id,
          title: sample.title,
          impact: sample.impact,
          raisedBy: sample.raisedBy,
          raisedByRef: sample.raisedByRef,
          isSample: true,
        }),
      );
    }
    return caseIds;
  },
});

export const advance = mutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    requireDevTools();
    await requireSampleCase(ctx, caseId);
    return await advanceOnce(ctx, caseId);
  },
});

export const autoRunStep = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    if (!devToolsEnabled()) return;
    if (!(await ctx.db.get(caseId))?.isSample) return;
    const status = await advanceOnce(ctx, caseId);
    if (!status || isClosed(status)) return;
    await ctx.scheduler.runAfter(AUTO_RUN_INTERVAL_MS, internal.dev.autoRunStep, {
      caseId,
    });
  },
});

export const autoRun = mutation({
  args: { caseId: v.optional(v.id("cases")) },
  handler: async (ctx, { caseId }) => {
    requireDevTools();
    if (caseId) await requireSampleCase(ctx, caseId);
    const targets = caseId
      ? [caseId]
      : (await sampleCases(ctx).collect())
          .filter((c) => !isClosed(c.status))
          .map((c) => c._id);

    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    const scheduled = new Set(
      jobs
        .filter(
          (job) =>
            job.state.kind === "pending" && job.name.endsWith(":autoRunStep"),
        )
        .map((job) => (job.args[0] as { caseId?: string } | undefined)?.caseId),
    );

    let offset = 0;
    for (const id of targets) {
      if (scheduled.has(id)) continue;
      await ctx.scheduler.runAfter(offset, internal.dev.autoRunStep, {
        caseId: id,
      });
      offset += AUTO_RUN_STAGGER_MS;
    }
  },
});

export const resetSamples = mutation({
  args: {},
  handler: async (ctx) => {
    requireDevTools();
    const samples = await sampleCases(ctx).collect();
    for (const sampleCase of samples) {
      const attempts = await ctx.db
        .query("stepAttempts")
        .withIndex("by_case", (q) => q.eq("caseId", sampleCase._id))
        .collect();
      for (const attempt of attempts) await ctx.db.delete(attempt._id);
      const steps = await ctx.db
        .query("steps")
        .withIndex("by_case", (q) => q.eq("caseId", sampleCase._id))
        .collect();
      for (const step of steps) await ctx.db.delete(step._id);
      await ctx.db.delete(sampleCase._id);
    }
    const apps = await sampleApps(ctx).collect();
    for (const app of apps) await ctx.db.delete(app._id);
    return samples.length;
  },
});

const findLiveApp = (ctx: QueryCtx) =>
  ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", LIVE_APP_NAME))
    .first();

const liveCases = async (ctx: QueryCtx) => {
  const app = await findLiveApp(ctx);
  if (!app) return [];
  return await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", app._id)).order("desc").collect();
};

const requireLiveCase = async (ctx: QueryCtx, caseId: Id<"cases">) => {
  const [row, app] = await Promise.all([ctx.db.get(caseId), findLiveApp(ctx)]);
  if (!row || !app || row.appId !== app._id) {
    throw new Error(`Case ${caseId} is not a live run test case, so dev tools will not change it.`);
  }
};

export const startLiveRun = mutation({
  args: {
    staged: v.optional(
      v.union(v.literal("retry"), v.literal("timeout"), v.literal("unresolved")),
    ),
  },
  handler: async (ctx, { staged }) => {
    requireDevTools();
    const appId =
      (await findLiveApp(ctx))?._id ?? (await ctx.db.insert("apps", { name: LIVE_APP_NAME }));
    const caseId = await startCaseRun(ctx, {
      appId,
      kind: "outage",
      title: staged ? `Live run test case (staged ${staged})` : "Live run test case",
      impact: "A dev test case. Its steps run on the backend with placeholder handlers.",
      raisedBy: "owner",
      raisedByRef: "dev tools",
    });
    if (staged) {
      const step = await ctx.db
        .query("steps")
        .withIndex("by_case_and_key", (q) => q.eq("caseId", caseId).eq("key", LIVE_STAGED_STEP))
        .unique();
      if (step) await ctx.db.patch(step._id, { staged: LIVE_STAGINGS[staged] });
    }
    return caseId;
  },
});

export const approveLiveRun = mutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    requireDevTools();
    await requireLiveCase(ctx, caseId);
    await approveCase(ctx, caseId);
  },
});

export const declineLiveRun = mutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    requireDevTools();
    await requireLiveCase(ctx, caseId);
    await declineCase(ctx, caseId);
  },
});

export const clearLiveRuns = mutation({
  args: {},
  handler: async (ctx) => {
    requireDevTools();
    const cases = await liveCases(ctx);
    for (const row of cases) {
      for (const table of ["stepAttempts", "steps"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_case", (q) => q.eq("caseId", row._id))
          .collect();
        for (const doc of rows) await ctx.db.delete(doc._id);
      }
      await ctx.db.delete(row._id);
    }
    const app = await findLiveApp(ctx);
    if (app) await ctx.db.delete(app._id);
    return cases.length;
  },
});

export const registerBooking = mutation({
  args: {},
  handler: async (ctx) => {
    requireDevTools();
    return await registerBookingApp(ctx);
  },
});

// Runs the monitor once, now, instead of waiting for the next scheduled check.
export const checkNow = action({
  args: {},
  handler: async (ctx): Promise<MonitorResult> => {
    requireDevTools();
    return await checkJourneys(ctx);
  },
});

// Test instrumentation: turns the booking app's staged provider timeout on or off. Nothing else in turtl calls it.
export const stageOutage = action({
  args: { on: v.boolean() },
  handler: async (_ctx, { on }) => {
    requireDevTools();
    const base = controlBase();
    if (!base) throw new Error("PROTECTED_APP_URL is not set on this deployment.");
    const response = await call(`${base}/staged-failure`, {
      method: "POST",
      body: { providerTimeout: on },
      credentialRef: CREDENTIAL_REF,
    });
    if (response.kind !== "response" || response.status !== 200) {
      throw new Error(`Could not change the staged outage: ${describeFailure(response)}.`);
    }
    return { staged: true, providerTimeout: on };
  },
});

export const stageStoreFailure = action({
  args: { on: v.boolean() },
  handler: async (_ctx, { on }) => {
    requireDevTools();
    const base = controlBase();
    if (!base) throw new Error("PROTECTED_APP_URL is not set on this deployment.");
    const response = await call(`${base}/staged-failure`, {
      method: "POST",
      body: { bookingStoreFailure: on },
      credentialRef: CREDENTIAL_REF,
    });
    if (response.kind !== "response" || response.status !== 200) throw new Error(`Could not change the staged store failure: ${describeFailure(response)}.`);
    return { staged: true, bookingStoreFailure: on };
  },
});

export const recommendationsOn = action({
  args: {},
  handler: async () => {
    requireDevTools();
    const base = controlBase();
    if (!base) throw new Error("PROTECTED_APP_URL is not set on this deployment.");
    const response = await call(`${base}/flags`, { method: "POST", body: { recommendationsEnabled: true }, credentialRef: CREDENTIAL_REF });
    if (response.kind !== "response" || response.status !== 200 || (response.body as { recommendationsEnabled?: unknown } | null)?.recommendationsEnabled !== true) throw new Error(`The owner could not confirm recommendations are on: ${describeFailure(response)}.`);
    return { recommendationsEnabled: true, summary: "The owner turned recommendations back on. turtl did not run a recovery. Staged switches and incident history were not changed." };
  },
});

export const resetBooking = action({
  args: {},
  handler: async (ctx): Promise<{ summary: string; deletedCases: number; deletedMemories: number; deletedPermissions: number; deleted: Record<string, number> }> => {
    requireDevTools();
    const scope = await ctx.runMutation(internal.memory.reset.prepare, {});
    const completed = ["Open booking cases were marked declined, pending work was cancelled, pass watermarks were cleared, and booking permissions were removed"];
    let deletionStarted = false;
    try {
      for (const [path, body] of [
        ["/staged-failure", { providerTimeout: false }],
        ["/staged-failure", { bookingStoreFailure: false }],
        ["/flags", { recommendationsEnabled: true }],
      ] as const) {
        const response = await call(`${scope.base}${path}`, { method: "POST", body, credentialRef: CREDENTIAL_REF });
        const [field, expected] = Object.entries(body)[0];
        if (response.kind !== "response" || response.status !== 200 || (response.body as Record<string, unknown> | null)?.[field] !== expected) throw new Error(`${path} did not confirm ${field}=${expected} (${describeFailure(response)}); that change is not confirmed`);
        completed.push(`${field}=${expected} was confirmed`);
      }
      const passedJourneys: { journeyId: Id<"journeys">; observedAt: number }[] = [];
      for (const journey of scope.journeys) {
        if (journey.check.kind !== "http") throw new Error("This journey needs a non-HTTP check");
        const observedAt = Date.now();
        const outcome = await runJourneyCheck(journey.check.config);
        if (!outcome.ok || outcome.result.verdict !== "passed") throw new Error("The fresh booking journey did not pass");
        passedJourneys.push({ journeyId: journey._id, observedAt });
      }
      completed.push("The fresh booking journey passed");
      deletionStarted = true;
      const deleted = await ctx.runMutation(internal.memory.reset.clear, { appId: scope.appId, caseIds: scope.caseIds, passedJourneys });
      const deletedPermissions = scope.permissionsDeleted + deleted.permissions;
      return {
        deletedCases: deleted.cases, deletedMemories: deleted.recoveryMemories, deletedPermissions,
        deleted: { ...deleted, permissions: deletedPermissions, cancelledScheduled: scope.cancelledScheduled + deleted.cancelledScheduled },
        summary: `Booking demo reset: deleted ${deleted.cases} booking cases and their history, ${deleted.recoveryMemories} recovery memories, and ${deletedPermissions} permissions. Recommendations are on, both staged failures are off, and the booking check passed. Registration, sample cases, and dev live runs were kept. Supermemory entries were not deleted; recall ignores entries without a Convex record.`,
      };
    } catch (error) {
      throw new Error(`Booking reset paused. ${completed.join(". ")}. ${error instanceof Error ? error.message : "The reset failed"}. ${deletionStarted ? "Incident deletion was not confirmed; inspect the current history before retrying." : "No incident rows were deleted."}`);
    }
  },
});

const bookingStatus = async (ctx: QueryCtx) => {
  const app = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", BOOKING_APP_NAME))
    .first();
  if (!app) return null;
  const latest = await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", app._id)).order("desc").first();
  const proposal = latest ? await latestProposal(ctx, latest._id) : null;
  const option = proposal?.options.find((o) => o.recommended) ?? proposal?.options[0];
  return {
    case: latest ? { _id: latest._id, status: latest.status, title: latest.title } : null,
    proposal:
      proposal && option && proposal.decisionStatus === "pending"
        ? { _id: proposal._id, version: proposal.version, optionKey: option.key }
        : null,
  };
};

export const status = query({
  args: {},
  handler: async (ctx) => {
    if (!devToolsEnabled()) return { enabled: false as const, cases: [], live: [], booking: null };
    const samples = await sampleCases(ctx).collect();
    const cases = await Promise.all(
      samples.map(async (sampleCase) => ({
        case: sampleCase,
        steps: await loadSteps(ctx, sampleCase._id),
      })),
    );
    const live = await Promise.all(
      (await liveCases(ctx)).map(async (row) => ({
        case: row,
        steps: await loadSteps(ctx, row._id),
      })),
    );
    return { enabled: true as const, cases, live, booking: await bookingStatus(ctx) };
  },
});
