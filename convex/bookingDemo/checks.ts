import { internalAction, type ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { catalog, revision } from "./catalog";
import { completeBooking } from "./journeyCore";
import { recommend } from "./provider";

type Step = { step: string; verdict: "passed" | "failed" | "skipped"; detail: string };
type JourneyError = { code: string; message: string; step: string; provider?: string; retryable?: boolean };
type Configuration = { recommendationsEnabled: boolean; providerTimeout: boolean; bookingStoreFailure: boolean };

type JourneyResult = {
  runId: string;
  verdict: "passed" | "failed";
  failedStep: string | null;
  error: JourneyError | null;
  steps: Step[];
  cleanup: { ok: boolean; deletedBookings: number };
  revision: string;
  environment: "protected-app";
  startedAt: number;
  completedAt: number;
};

// Every journey gets a fresh run id for its fixtures, always deletes them afterwards, and logs a failure with its code and run id.
async function runJourney(ctx: ActionCtx, journey: string, body: (runId: string, steps: Step[]) => Promise<JourneyError | null>): Promise<JourneyResult> {
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const steps: Step[] = [];
  let error = await body(runId, steps);
  let deletedBookings = 0;
  try {
    deletedBookings = await ctx.runMutation(internal.bookingDemo.records.cleanup, { fixtureRunId: runId });
    steps.push({ step: "cleanup", verdict: "passed", detail: `Deleted ${deletedBookings} fixture bookings; fixtures never count as customer impact.` });
  } catch {
    error = { code: "CLEANUP_FAILED", message: "Fixture cleanup failed; this run is not a pass.", step: "cleanup" };
    steps.push({ step: "cleanup", verdict: "failed", detail: error.message });
  }
  if (error) console.error(JSON.stringify({ event: "journey_check_failed", journey, runId, code: error.code, step: error.step }));
  return { runId, verdict: error ? "failed" : "passed", failedStep: error?.step ?? null, error, steps, cleanup: { ok: error?.code !== "CLEANUP_FAILED", deletedBookings }, revision: revision(), environment: "protected-app", startedAt, completedAt: Date.now() };
}

async function bookingSteps(ctx: ActionCtx, runId: string, steps: Step[], config: Configuration, recommendationsOff: string): Promise<JourneyError | null> {
  try {
    const fixture = catalog();
    steps.push({ step: "load_catalog", verdict: "passed", detail: "Selected the first service and time from the customer catalog." });
    const result = await completeBooking(ctx, { serviceId: fixture.services[0].id, date: fixture.date, time: fixture.slots[0], fixtureRunId: runId }, config);
    if (!result.ok) {
      if (result.error.step === "recommendations") {
        steps.push({ step: "recommendations", verdict: "failed", detail: result.error.message });
        steps.push({ step: "submit_booking", verdict: "skipped", detail: "The staged provider dependency blocked the booking write." });
      } else {
        steps.push({ step: "recommendations", verdict: "skipped", detail: config.recommendationsEnabled ? "The staged booking-store failure takes precedence; provider not called." : recommendationsOff });
        steps.push({ step: "submit_booking", verdict: "failed", detail: result.error.message });
      }
      steps.push({ step: "verify_persisted", verdict: "skipped", detail: "No confirmation to verify." });
      return result.error;
    }
    steps.push({ step: "recommendations", verdict: config.recommendationsEnabled ? "passed" : "skipped", detail: config.recommendationsEnabled ? "Simulated provider responded." : recommendationsOff });
    steps.push({ step: "submit_booking", verdict: "passed", detail: "Customer booking handler returned a confirmation." });
    const saved = await ctx.runQuery(internal.bookingDemo.records.readBooking, { bookingId: result.bookingId });
    const matches = saved?.fixtureRunId === runId && saved.serviceId === result.serviceId && saved.date === result.date && saved.time === result.time;
    steps.push({ step: "verify_persisted", verdict: matches ? "passed" : "failed", detail: matches ? "Confirmed the matching booking in the database." : "The stored booking did not match the confirmation." });
    return matches ? null : { code: "BOOKING_NOT_PERSISTED", message: "The stored booking did not match the confirmation.", step: "verify_persisted" };
  } catch {
    steps.push({ step: "submit_booking", verdict: "failed", detail: "The booking journey could not complete." });
    return { code: "JOURNEY_INTERNAL_ERROR", message: "The booking journey could not complete.", step: "submit_booking" };
  }
}

export const journey = internalAction({
  args: {},
  handler: async (ctx): Promise<JourneyResult & { configuration: Configuration }> => {
    const config = await ctx.runQuery(internal.bookingDemo.state.read, {});
    const result = await runJourney(ctx, "booking", (runId, steps) => bookingSteps(ctx, runId, steps, config, "Flag off: provider bypassed."));
    return { ...result, configuration: { recommendationsEnabled: config.recommendationsEnabled, providerTimeout: config.providerTimeout, bookingStoreFailure: config.bookingStoreFailure } };
  },
});

// "When optional recommendations are turned off, a customer can still make a booking": books as if the switch were off, leaving the live switch alone.
export const bookingWithoutRecommendations = internalAction({
  args: {},
  handler: async (ctx): Promise<JourneyResult> => {
    const live = await ctx.runQuery(internal.bookingDemo.state.read, {});
    const offForThisRun = `Recommendations were off for this check only, so the provider was not called; the live setting stayed ${live.recommendationsEnabled ? "on" : "off"}.`;
    return runJourney(ctx, "booking_without_recommendations", (runId, steps) => bookingSteps(ctx, runId, steps, { ...live, recommendationsEnabled: false }, offForThisRun));
  },
});

// "A customer can see the available treatments and appointment times": loads what the booking screen needs before it shows them.
export const catalogVisible = internalAction({
  args: {},
  handler: (ctx): Promise<JourneyResult> => runJourney(ctx, "catalog", async (_runId, steps) => {
    let shown: ReturnType<typeof catalog>;
    try {
      shown = await ctx.runQuery(api.bookingDemo.booking.getCatalog, {});
    } catch {
      steps.push({ step: "load_catalog", verdict: "failed", detail: "The customer catalog did not load." });
      steps.push({ step: "check_catalog", verdict: "skipped", detail: "No catalog to check." });
      steps.push({ step: "load_flags", verdict: "skipped", detail: "Stopped after the catalog failed to load." });
      return { code: "CATALOG_UNAVAILABLE", message: "The treatments and appointment times could not be loaded.", step: "load_catalog" };
    }
    steps.push({ step: "load_catalog", verdict: "passed", detail: "The customer catalog loaded." });
    const treatments = shown.services.filter((s) => s.id && s.name && s.minutes > 0 && s.price >= 0).length;
    const times = shown.slots.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).length;
    const found = `Found ${treatments} treatments and ${times} appointment times for ${shown.date || "no date"}.`;
    if (!treatments || !times || !(shown.date >= new Date().toISOString().slice(0, 10))) {
      steps.push({ step: "check_catalog", verdict: "failed", detail: found });
      steps.push({ step: "load_flags", verdict: "skipped", detail: "Stopped after the catalog check failed." });
      return { code: "CATALOG_INCOMPLETE", message: "The catalog has no bookable treatment, appointment time, or upcoming date.", step: "check_catalog" };
    }
    steps.push({ step: "check_catalog", verdict: "passed", detail: found });
    try {
      await ctx.runQuery(api.bookingDemo.booking.getFlags, {});
    } catch {
      steps.push({ step: "load_flags", verdict: "failed", detail: "The booking screen's settings did not load, so it would keep showing a loading state." });
      return { code: "FLAGS_UNAVAILABLE", message: "The booking screen's settings could not be loaded, so customers cannot see the catalog.", step: "load_flags" };
    }
    steps.push({ step: "load_flags", verdict: "passed", detail: "The booking screen's settings loaded, so it can show the catalog." });
    return null;
  }),
});

type Dependency = { dependency: "booking_store" | "recommendations_provider"; status: "ok" | "failed" | "not_required" | "not_checked"; detail: string; code?: string };

// Can the app take a booking right now? The store must answer and accept writes; the provider counts only while bookings wait for it.
export async function checkReadiness(ctx: ActionCtx) {
  const requestId = crypto.randomUUID();
  const state: Configuration | null = await ctx.runQuery(internal.bookingDemo.state.read, {}).catch(() => null);
  const dependencies: Dependency[] = [];
  if (!state) dependencies.push({ dependency: "booking_store", status: "failed", code: "BOOKING_STORE_UNAVAILABLE", detail: "The booking database did not answer." });
  else if (state.bookingStoreFailure) dependencies.push({ dependency: "booking_store", status: "failed", code: "BOOKING_STORE_UNAVAILABLE", detail: "The booking database answered but is refusing new bookings." });
  else dependencies.push({ dependency: "booking_store", status: "ok", detail: "The booking database answered and accepts bookings." });
  if (!state) {
    dependencies.push({ dependency: "recommendations_provider", status: "not_checked", detail: "Not checked: without the settings it is unknown whether bookings wait for this provider." });
  } else if (!state.recommendationsEnabled) {
    dependencies.push({ dependency: "recommendations_provider", status: "not_required", detail: "Recommendations are off, so bookings do not wait for this provider." });
  } else {
    try {
      await recommend(state.providerTimeout);
      dependencies.push({ dependency: "recommendations_provider", status: "ok", detail: "The recommendation provider answered." });
    } catch {
      dependencies.push({ dependency: "recommendations_provider", status: "failed", code: "RECOMMENDATIONS_TIMEOUT", detail: "The recommendation provider did not answer, and bookings wait for it while recommendations are on." });
    }
  }
  const failed = dependencies.find((d) => d.status === "failed");
  if (failed) console.error(JSON.stringify({ event: "readiness_failed", requestId, dependency: failed.dependency, code: failed.code }));
  return { ready: !failed, service: "protected-booking", requestId, failing: failed ? { dependency: failed.dependency, code: failed.code, message: failed.detail } : null, dependencies, checkedAt: Date.now() };
}
