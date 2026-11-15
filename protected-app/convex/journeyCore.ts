import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { catalog } from "./catalog";
import { recommend } from "./provider";
import type { Id } from "./_generated/dataModel";

type BookingInput = { serviceId: string; date: string; time: string; fixtureRunId?: string };
type BookingFailure = { code: string; message: string; step: string; provider?: string; retryable: boolean };
type BookingResult =
  | { ok: true; bookingId: Id<"bookings">; serviceId: string; date: string; time: string }
  | { ok: false; errorId: Id<"bookingAttempts"> | null; error: BookingFailure };

export async function completeBooking(ctx: ActionCtx, input: BookingInput, config?: { recommendationsEnabled: boolean; providerTimeout: boolean }): Promise<BookingResult> {
  const currentCatalog = catalog();
  let error: BookingFailure | undefined;
  if (!currentCatalog.services.some((s) => s.id === input.serviceId) || !currentCatalog.slots.includes(input.time) || input.date !== currentCatalog.date) {
    error = { code: "INVALID_SELECTION", message: "Choose an available service and time.", step: "submit_booking", retryable: false };
  } else {
    const state = config ?? await ctx.runQuery(internal.state.read, {});
    if (state.recommendationsEnabled) {
      // STAGED DEFECT: an optional recommendation gates the core booking write.
      // The demo's later permanent repair removes this coupling, not the flag.
      try {
        await recommend(state.providerTimeout);
      } catch {
        error = { code: "RECOMMENDATIONS_TIMEOUT", message: "The recommendation provider timed out. Your booking was not saved.", step: "recommendations", provider: "simulated-recommendations", retryable: true };
      }
    }
  }
  if (error) {
    const errorId = input.fixtureRunId ? null : await ctx.runMutation(internal.records.saveFailure, {
      serviceId: input.serviceId, date: input.date, time: input.time, error,
    });
    return { ok: false, errorId, error };
  }
  const bookingId = await ctx.runMutation(internal.records.saveBooking, input);
  return { ok: true, bookingId, serviceId: input.serviceId, date: input.date, time: input.time };
}
