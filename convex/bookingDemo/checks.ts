import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { catalog, revision } from "./catalog";
import { completeBooking, JOURNEY_SCENARIOS, type JourneyScenario } from "./journeyCore";

type JourneyResult = {
  runId: string;
  verdict: "passed" | "failed";
  failedStep: string | null;
  error: { code: string; message: string; step?: string; provider?: string; retryable?: boolean } | null;
  steps: { step: string; verdict: "passed" | "failed" | "skipped"; detail: string }[];
  cleanup: { ok: boolean; deletedBookings: number };
  configuration: { recommendationsEnabled: boolean; providerTimeout: boolean; bookingStoreFailure: boolean };
  revision: string;
  environment: "protected-app";
  startedAt: number;
  completedAt: number;
  /** Present only when a scenario was asked for, and then the run applied it. */
  scenario?: JourneyScenario;
};

// One fixture booking through the customer's own booking path, then cleanup. With a scenario, the run uses the
// live settings with that scenario applied in memory: the settings row is never written, the fixture booking is
// deleted like any other, and a failure is not recorded as customer impact. `configuration` always reports the
// live settings, not the scenario's.
export const journey = internalAction({
  args: { scenario: v.optional(v.literal("slow_recommendations")) },
  returns: v.object({
    runId: v.string(),
    verdict: v.union(v.literal("passed"), v.literal("failed")),
    failedStep: v.union(v.string(), v.null()),
    error: v.union(
      v.object({ code: v.string(), message: v.string(), step: v.optional(v.string()), provider: v.optional(v.string()), retryable: v.optional(v.boolean()) }),
      v.null(),
    ),
    steps: v.array(v.object({ step: v.string(), verdict: v.union(v.literal("passed"), v.literal("failed"), v.literal("skipped")), detail: v.string() })),
    cleanup: v.object({ ok: v.boolean(), deletedBookings: v.number() }),
    configuration: v.object({ recommendationsEnabled: v.boolean(), providerTimeout: v.boolean(), bookingStoreFailure: v.boolean() }),
    revision: v.string(),
    environment: v.literal("protected-app"),
    startedAt: v.number(),
    completedAt: v.number(),
    scenario: v.optional(v.literal("slow_recommendations")),
  }),
  handler: async (ctx, { scenario }): Promise<JourneyResult> => {
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    const live = await ctx.runQuery(internal.bookingDemo.state.read, {});
    const config = scenario ? JOURNEY_SCENARIOS[scenario].apply(live) : live;
    const steps: { step: string; verdict: "passed" | "failed" | "skipped"; detail: string }[] = [];
    let failedStep: string | null = null;
    let error: { code: string; message: string } | null = null;
    let deletedBookings = 0;
    try {
      const fixture = catalog();
      steps.push({ step: "load_catalog", verdict: "passed", detail: "Selected the first service and time from the customer catalog." });
      const result = await completeBooking(ctx, { serviceId: fixture.services[0].id, date: fixture.date, time: fixture.slots[0], fixtureRunId: runId }, config);
      if (!result.ok) {
        failedStep = result.error.step;
        error = result.error;
        if (failedStep === "recommendations") {
          steps.push({ step: "recommendations", verdict: "failed", detail: scenario ? `${JOURNEY_SCENARIOS[scenario].detail} ${result.error.message}` : result.error.message });
          steps.push({ step: "submit_booking", verdict: "skipped", detail: scenario ? "The slow provider blocked the booking write." : "The staged provider dependency blocked the booking write." });
        } else {
          steps.push({ step: "recommendations", verdict: "skipped", detail: "The staged booking-store failure takes precedence; provider not called." });
          steps.push({ step: "submit_booking", verdict: "failed", detail: result.error.message });
        }
        steps.push({ step: "verify_persisted", verdict: "skipped", detail: "No confirmation to verify." });
      } else {
        steps.push({ step: "recommendations", verdict: config.recommendationsEnabled ? "passed" : "skipped", detail: config.recommendationsEnabled ? "Simulated provider responded." : `Flag off: provider bypassed.${scenario ? " The scenario's slow provider was never called." : ""}` });
        steps.push({ step: "submit_booking", verdict: "passed", detail: "Customer booking handler returned a confirmation." });
        const saved = await ctx.runQuery(internal.bookingDemo.records.readBooking, { bookingId: result.bookingId });
        const matches = saved?.fixtureRunId === runId && saved.serviceId === result.serviceId && saved.date === result.date && saved.time === result.time;
        steps.push({ step: "verify_persisted", verdict: matches ? "passed" : "failed", detail: matches ? "Confirmed the matching booking in the database." : "The stored booking did not match the confirmation." });
        if (!matches) failedStep = "verify_persisted";
      }
    } catch {
      failedStep = "submit_booking";
      error = { code: "JOURNEY_INTERNAL_ERROR", message: "The booking journey could not complete." };
      steps.push({ step: failedStep, verdict: "failed", detail: error.message });
    } finally {
      try {
        deletedBookings = await ctx.runMutation(internal.bookingDemo.records.cleanup, { fixtureRunId: runId });
        steps.push({ step: "cleanup", verdict: "passed", detail: `Deleted ${deletedBookings} fixture bookings; fixtures never count as customer impact.` });
      } catch {
        failedStep = "cleanup";
        error = { code: "CLEANUP_FAILED", message: "Fixture cleanup failed; this run is not a pass." };
        steps.push({ step: "cleanup", verdict: "failed", detail: error.message });
      }
    }
    return { runId, verdict: failedStep ? "failed" : "passed", failedStep, error, steps, cleanup: { ok: !steps.some((s) => s.step === "cleanup" && s.verdict === "failed"), deletedBookings }, configuration: { recommendationsEnabled: live.recommendationsEnabled, providerTimeout: live.providerTimeout, bookingStoreFailure: live.bookingStoreFailure }, revision: revision(), environment: "protected-app", startedAt, completedAt: Date.now(), ...(scenario && { scenario }) };
  },
});
