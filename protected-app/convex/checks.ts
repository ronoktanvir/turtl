import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { catalog, revision } from "./catalog";
import { completeBooking } from "./journeyCore";

type JourneyResult = {
  runId: string;
  verdict: "passed" | "failed";
  failedStep: string | null;
  error: { code: string; message: string; step?: string; provider?: string; retryable?: boolean } | null;
  steps: { step: string; verdict: "passed" | "failed" | "skipped"; detail: string }[];
  cleanup: { ok: boolean; deletedBookings: number };
  configuration: { recommendationsEnabled: boolean; providerTimeout: boolean };
  revision: string;
  environment: "protected-app";
  startedAt: number;
  completedAt: number;
};

export const journey = internalAction({
  args: {},
  handler: async (ctx): Promise<JourneyResult> => {
    const startedAt = Date.now();
    const runId = crypto.randomUUID();
    const config = await ctx.runQuery(internal.state.read, {});
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
        steps.push({ step: "recommendations", verdict: "failed", detail: result.error.message });
        steps.push({ step: "submit_booking", verdict: "skipped", detail: "The staged provider dependency blocked the booking write." });
        steps.push({ step: "verify_persisted", verdict: "skipped", detail: "No confirmation to verify." });
      } else {
        steps.push({ step: "recommendations", verdict: config.recommendationsEnabled ? "passed" : "skipped", detail: config.recommendationsEnabled ? "Simulated provider responded." : "Flag off: provider bypassed." });
        steps.push({ step: "submit_booking", verdict: "passed", detail: "Customer booking handler returned a confirmation." });
        const saved = await ctx.runQuery(internal.records.readBooking, { bookingId: result.bookingId });
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
        deletedBookings = await ctx.runMutation(internal.records.cleanup, { fixtureRunId: runId });
        steps.push({ step: "cleanup", verdict: "passed", detail: `Deleted ${deletedBookings} fixture bookings; fixtures never count as customer impact.` });
      } catch {
        failedStep = "cleanup";
        error = { code: "CLEANUP_FAILED", message: "Fixture cleanup failed; this run is not a pass." };
        steps.push({ step: "cleanup", verdict: "failed", detail: error.message });
      }
    }
    return { runId, verdict: failedStep ? "failed" : "passed", failedStep, error, steps, cleanup: { ok: !steps.some((s) => s.step === "cleanup" && s.verdict === "failed"), deletedBookings }, configuration: { recommendationsEnabled: config.recommendationsEnabled, providerTimeout: config.providerTimeout }, revision: revision(), environment: "protected-app", startedAt, completedAt: Date.now() };
  },
});
