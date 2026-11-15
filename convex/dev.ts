import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { CASE_KINDS, STAGES, STAGE_IDS } from "./constants";
import type { CaseKind, RaisedBy } from "./constants";

declare const process: { env: Record<string, string | undefined> };

const AUTO_RUN_INTERVAL_MS = 1200;
const AUTO_RUN_STAGGER_MS = 400;

const SAMPLES: Record<CaseKind, { title: string; raisedBy: RaisedBy }> = {
  outage: { title: "Customers can't complete bookings", raisedBy: "monitor" },
  bug_report: {
    title: "The confirmation email shows the wrong time",
    raisedBy: "customer",
  },
  feature_request: {
    title: "Let customers reschedule a booking",
    raisedBy: "customer",
  },
};

const isEnabled = () => process.env.DEV_TOOLS_ENABLED === "true";

const requireEnabled = () => {
  if (!isEnabled()) {
    throw new Error("Dev tools are disabled on this deployment.");
  }
};

const sortByStage = (steps: Doc<"steps">[]) =>
  steps.sort((a, b) => STAGE_IDS.indexOf(a.stage) - STAGE_IDS.indexOf(b.stage));

const advanceOnce = async (
  ctx: MutationCtx,
  caseId: Id<"cases">,
): Promise<Doc<"cases">["status"] | null> => {
  const sampleCase = await ctx.db.get(caseId);
  if (!sampleCase) return null;
  if (sampleCase.status !== "open") return sampleCase.status;

  const steps = sortByStage(
    await ctx.db
      .query("steps")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect(),
  );
  const current = steps.find(
    (step) => step.status !== "done" && step.status !== "skipped",
  );
  if (!current) return sampleCase.status;

  const now = Date.now();
  if (current.status === "pending") {
    await ctx.db.patch(current._id, {
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(caseId, { updatedAt: now });
    return "open";
  }
  if (current.status !== "running") {
    throw new Error(`Step ${current.stage} is ${current.status}; cannot advance.`);
  }

  await ctx.db.patch(current._id, {
    status: "done",
    finishedAt: now,
    updatedAt: now,
  });
  const finished = steps.every(
    (step) =>
      step._id === current._id ||
      step.status === "done" ||
      step.status === "skipped",
  );
  if (!finished) {
    await ctx.db.patch(caseId, { updatedAt: now });
    return "open";
  }
  await ctx.db.patch(caseId, {
    status: "resolved",
    closedAt: now,
    updatedAt: now,
  });
  return "resolved";
};

export const createSampleCases = mutation({
  args: {},
  handler: async (ctx) => {
    requireEnabled();
    const now = Date.now();
    const caseIds: Id<"cases">[] = [];
    for (const kind of CASE_KINDS) {
      const sample = SAMPLES[kind.id];
      const caseId = await ctx.db.insert("cases", {
        title: sample.title,
        kind: kind.id,
        raisedBy: sample.raisedBy,
        status: "open",
        updatedAt: now,
        isSample: true,
      });
      for (const stage of STAGES) {
        await ctx.db.insert("steps", {
          caseId,
          stage: stage.id,
          status: "pending",
          attempt: 1,
          summary: `Sample: ${stage.label.toLowerCase()}.`,
          updatedAt: now,
        });
      }
      caseIds.push(caseId);
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
    if (status !== "open") return;
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
          .filter((c) => c.status === "open")
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
      const steps = await ctx.db
        .query("steps")
        .withIndex("by_case", (q) => q.eq("caseId", sampleCase._id))
        .collect();
      for (const step of steps) await ctx.db.delete(step._id);
      await ctx.db.delete(sampleCase._id);
    }
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
        steps: sortByStage(
          await ctx.db
            .query("steps")
            .withIndex("by_case", (q) => q.eq("caseId", sampleCase._id))
            .collect(),
        ),
      })),
    );
    return { enabled: true as const, cases };
  },
});
