import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { CASE_KINDS, CLOSED_CASE_STATUSES, STAGES } from "./constants";
import type { CaseKind, CaseStatus, RaisedBy } from "./constants";
import {
  createCaseFromTemplate,
  finishAttempt,
  loadSteps,
  startAttempt,
} from "./workflow";

declare const process: { env: Record<string, string | undefined> };

const AUTO_RUN_INTERVAL_MS = 1200;
const AUTO_RUN_STAGGER_MS = 400;

const SAMPLE_APP = { name: "Sample booking app", isSample: true };

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

const isEnabled = () => process.env.DEV_TOOLS_ENABLED === "true";

const requireEnabled = () => {
  if (!isEnabled()) {
    throw new Error("Dev tools are disabled on this deployment.");
  }
};

const isClosed = (status: CaseStatus) =>
  (CLOSED_CASE_STATUSES as readonly string[]).includes(status);

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
    requireEnabled();
    const existing = await ctx.db
      .query("apps")
      .filter((q) => q.eq(q.field("isSample"), true))
      .first();
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
    requireEnabled();
    return await advanceOnce(ctx, caseId);
  },
});

export const autoRunStep = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    if (!isEnabled()) return;
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
    requireEnabled();
    const targets = caseId
      ? [caseId]
      : (
          await ctx.db
            .query("cases")
            .filter((q) => q.eq(q.field("isSample"), true))
            .collect()
        )
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
    requireEnabled();
    const samples = await ctx.db
      .query("cases")
      .filter((q) => q.eq(q.field("isSample"), true))
      .collect();
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
    const apps = await ctx.db
      .query("apps")
      .filter((q) => q.eq(q.field("isSample"), true))
      .collect();
    for (const app of apps) await ctx.db.delete(app._id);
    return samples.length;
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    if (!isEnabled()) return { enabled: false as const, cases: [] };
    const samples = await ctx.db
      .query("cases")
      .filter((q) => q.eq(q.field("isSample"), true))
      .collect();
    const cases = await Promise.all(
      samples.map(async (sampleCase) => ({
        case: sampleCase,
        steps: await loadSteps(ctx, sampleCase._id),
      })),
    );
    return { enabled: true as const, cases };
  },
});
