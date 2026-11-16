import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { catalog } from "./catalog";
import { recommend } from "./provider";
import type { Id } from "../_generated/dataModel";

type BookingInput = { serviceId: string; date: string; time: string; fixtureRunId?: string };
type BookingFailure = { code: string; message: string; step: string; provider?: string; retryable: boolean };
type BookingResult =
  | { ok: true; bookingId: Id<"bookingDemoBookings">; serviceId: string; date: string; time: string }
  | { ok: false; errorId: Id<"bookingDemoAttempts"> | null; error: BookingFailure };

export async function completeBooking(ctx: ActionCtx, input: BookingInput, config?: { recommendationsEnabled: boolean; providerTimeout: boolean; bookingStoreFailure: boolean }): Promise<BookingResult> {
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
