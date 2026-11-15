import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { CLOSED_CASE_STATUSES } from "./constants";
import { controlBase, readErrors, runJourneyCheck } from "./protectedApp/client";
import { startCaseRun } from "./runner/run";

// A case stops counting as open once it is closed or its service is restored.
const NOT_OPEN: readonly string[] = [...CLOSED_CASE_STATUSES, "restored"];

export const signatureFor = (journeyId: Id<"journeys">) => `journey_failed:${journeyId}`;

export const journeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("journeys").collect();
    return await Promise.all(
      rows.map(async (journey) => ({ journey, app: await ctx.db.get(journey.appId) })),
    );
  },
});

const vCounts = v.object({
  totalBookings: v.number(),
  failedBookings: v.number(),
  errorRate: v.number(),
});

function describeImpact(
  failedStep: string,
  counts: { totalBookings: number; failedBookings: number; errorRate: number } | null,
  countsReason: string | null,
) {
  const check = `The booking check fails at the "${failedStep}" step, so a booking cannot be completed.`;
  if (!counts) {
    return {
      title: "Customers may not be able to book",
      impact: `${check} Failed booking counts could not be read (${countsReason ?? "unknown reason"}).`,
    };
  }
  if (counts.failedBookings === 0) {
    return {
      title: "Booking is failing",
      impact: `${check} No customer booking has failed in the last 15 minutes (${counts.totalBookings} attempted), but the next customer is likely to hit it.`,
    };
  }
  return {
    title: `Customers can't book: ${counts.failedBookings} of ${counts.totalBookings} bookings failed`,
    impact: `${counts.failedBookings} of ${counts.totalBookings} booking attempts in the last 15 minutes failed (${Math.round(counts.errorRate * 100)}%). ${check}`,
  };
}

// A passing check of the journey, from the monitor or from verify, re-arms its signature.
export const recordPass = internalMutation({
  args: { journeyId: v.id("journeys") },
  handler: async (ctx, { journeyId }) => {
    if (await ctx.db.get(journeyId)) await ctx.db.patch(journeyId, { lastPassedAt: Date.now() });
  },
});

// Opens one case per failure of a journey: nothing while a case with its signature is open, and nothing
// after that case closes until the journey has passed again.
export const openCase = internalMutation({
  args: {
    journeyId: v.id("journeys"),
    failedStep: v.string(),
    counts: v.union(vCounts, v.null()),
    countsReason: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { journeyId, failedStep, counts, countsReason }) => {
    const journey = await ctx.db.get(journeyId);
    if (!journey) throw new Error("Journey not found.");
    const signature = signatureFor(journeyId);
    const previous = await ctx.db
      .query("cases")
      .withIndex("by_app_and_signature", (q) => q.eq("appId", journey.appId).eq("signature", signature))
      .collect();
    const existing = previous.find((row) => !NOT_OPEN.includes(row.status));
    if (existing) return { opened: false as const, caseId: existing._id, reason: "a case for this failure is open" };
    const last = previous.reduce<(typeof previous)[number] | null>(
      (latest, row) => (!latest || row._creationTime > latest._creationTime ? row : latest),
      null,
    );
    if (last && (journey.lastPassedAt ?? 0) <= last._creationTime) {
      return {
        opened: false as const,
        caseId: last._id,
        reason: `the journey has not passed since the last case for it (${last.status})`,
      };
    }
    const { title, impact } = describeImpact(failedStep, counts, countsReason);
    const caseId = await startCaseRun(ctx, {
      appId: journey.appId,
      title,
      impact,
      kind: "outage",
      raisedBy: "monitor",
      raisedByRef: `journey check: ${journey.name}`,
      signature,
    });
    await ctx.db.patch(caseId, { journeyId });
    const app = await ctx.db.get(journey.appId);
    await ctx.scheduler.runAfter(0, internal.keiki.notifyOwner, {
      text: `Something is wrong with ${app?.name ?? "your app"}: ${title}. turtl is looking into it now.`,
    });
    return { opened: true as const, caseId };
  },
});

export type MonitorResult =
  | { skipped: string }
  | {
      checked: {
        journeyId: Id<"journeys">;
        outcome: "passed" | "failed" | "check_error";
        detail: string;
        caseId?: Id<"cases">;
        opened?: boolean;
        reason?: string;
      }[];
    };

export async function checkJourneys(ctx: ActionCtx): Promise<MonitorResult> {
  if (!controlBase()) {
    return { skipped: "PROTECTED_APP_URL is not set on this deployment, so no journey was checked." };
  }
  const rows = await ctx.runQuery(internal.monitor.journeys, {});
  const checked = [];
  for (const { journey, app } of rows) {
    if (journey.check.kind !== "http" || !app?.productionUrl) continue;
    const outcome = await runJourneyCheck(journey.check.config);
    if (!outcome.ok) {
      checked.push({ journeyId: journey._id, outcome: "check_error" as const, detail: outcome.reason });
      continue;
    }
    const { result } = outcome;
    if (result.verdict === "passed") {
      await ctx.runMutation(internal.monitor.recordPass, { journeyId: journey._id });
      checked.push({ journeyId: journey._id, outcome: "passed" as const, detail: "The booking check passed." });
      continue;
    }
    const errors = await readErrors(app.productionUrl);
    const opened = await ctx.runMutation(internal.monitor.openCase, {
      journeyId: journey._id,
      failedStep: result.failedStep ?? "unknown",
      counts: errors.ok
        ? {
            totalBookings: errors.body.counts.totalBookings,
            failedBookings: errors.body.counts.failedBookings,
            errorRate: errors.body.counts.errorRate,
          }
        : null,
      countsReason: errors.ok ? null : errors.reason,
    });
    checked.push({
      journeyId: journey._id,
      outcome: "failed" as const,
      detail: `The booking check failed at "${result.failedStep}" (${result.error?.code ?? "no error code"}).`,
      ...opened,
    });
  }
  return { checked };
}

// Run by convex/crons.ts.
export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<MonitorResult> => checkJourneys(ctx),
});
