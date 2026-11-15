import { v } from "convex/values";

export const bookingError = v.object({
  code: v.string(),
  message: v.string(),
  step: v.string(),
  provider: v.optional(v.string()),
  retryable: v.boolean(),
});
