import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { catalog } from "./catalog";
import { recommend } from "./provider";
import type { Id } from "../_generated/dataModel";

type BookingInput = { serviceId: string; date: string; time: string; fixtureRunId?: string };
export type BookingConfig = { recommendationsEnabled: boolean; providerTimeout: boolean; bookingStoreFailure: boolean };

// Scenarios the journey check can run besides the plain journey: the live settings with one dependency
// degraded for that one run. Nothing is written to the settings, so no customer ever meets a scenario.
// turtl's prevention checks ask for these by id (CHECK_SCENARIOS in convex/structural/rules.ts).
export const JOURNEY_SCENARIOS = {
  slow_recommendations: {
    apply: (config: BookingConfig): BookingConfig => ({ ...config, providerTimeout: true }),
    detail: "For this run only, the recommendations provider was slowed past its time limit. The live settings were not changed.",
  },
} as const;

export type JourneyScenario = keyof typeof JOURNEY_SCENARIOS;

// Reads ?scenario= from a journey-check request. No parameter is the plain journey, exactly as before scenarios
// existed. An empty, repeated or unknown one is refused, so a caller never gets a plain run it did not ask for.
export function readScenario(url: URL): { ok: true; scenario: JourneyScenario | null } | { ok: false; message: string } {
  const values = url.searchParams.getAll("scenario");
  if (values.length === 0) return { ok: true, scenario: null };
  const [value] = values;
  if (values.length > 1 || !Object.prototype.hasOwnProperty.call(JOURNEY_SCENARIOS, value)) {
    return { ok: false, message: `Unknown scenario. This app can run: ${Object.keys(JOURNEY_SCENARIOS).join(", ")}.` };
  }
  return { ok: true, scenario: value as JourneyScenario };
}

type BookingFailure = { code: string; message: string; step: string; provider?: string; retryable: boolean };
type BookingResult =
  | { ok: true; bookingId: Id<"bookingDemoBookings">; serviceId: string; date: string; time: string }
  | { ok: false; errorId: Id<"bookingDemoAttempts"> | null; error: BookingFailure };

export async function completeBooking(ctx: ActionCtx, input: BookingInput, config?: BookingConfig): Promise<BookingResult> {
  const currentCatalog = catalog();
  const state = config ?? await ctx.runQuery(internal.bookingDemo.state.read, {});
  let error: BookingFailure | undefined;
  if (!currentCatalog.services.some((s) => s.id === input.serviceId) || !currentCatalog.slots.includes(input.time) || input.date !== currentCatalog.date) {
    error = { code: "INVALID_SELECTION", message: "Choose an available service and time.", step: "submit_booking", retryable: false };
  } else {
    if (state.recommendationsEnabled && !state.bookingStoreFailure) {
      // STAGED DEFECT: an optional recommendation gates the core booking write.
      // The demo's later permanent repair removes this coupling, not the flag.
      try {
        await recommend(state.providerTimeout);
      } catch {
        error = { code: "RECOMMENDATIONS_TIMEOUT", message: "The recommendation provider timed out. Your booking was not saved.", step: "recommendations", provider: "simulated-recommendations", retryable: true };
      }
    }
  }
  if (!error) {
    try {
      const bookingId = await ctx.runMutation(internal.bookingDemo.records.saveBooking, { ...input, bookingStoreFailure: state.bookingStoreFailure });
      return { ok: true, bookingId, serviceId: input.serviceId, date: input.date, time: input.time };
    } catch (cause) {
      if (!state.bookingStoreFailure) throw cause;
      error = { code: "BOOKING_STORE_UNAVAILABLE", message: "The booking store is unavailable. Your booking was not saved.", step: "submit_booking", retryable: true };
    }
  }
  const errorId = input.fixtureRunId ? null : await ctx.runMutation(internal.bookingDemo.records.saveFailure, {
    serviceId: input.serviceId, date: input.date, time: input.time, error,
  });
  return { ok: false, errorId, error };
}
