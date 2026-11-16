import { mutation } from "../_generated/server";
import { registerCodeChangeAction } from "../prTracking/catalog";
import { registerBookingApp } from "../protectedApp/registry";
import { issueKey } from "./keys";

declare const process: { env: Record<string, string | undefined> };

// Dev tools: registers the booking app with its pull request action and returns its intake key, issuing
// one the first time. Needs DEV_TOOLS_ENABLED=true and PROTECTED_APP_URL.
export const bookingKey = mutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.DEV_TOOLS_ENABLED !== "true") throw new Error("Dev tools are disabled on this deployment.");
    const { appId } = await registerBookingApp(ctx);
    await registerCodeChangeAction(ctx);
    const existing = (await ctx.db.query("intakeKeys").withIndex("by_app", (q) => q.eq("appId", appId)).collect()).find(
      (row) => row.revokedAt === undefined,
    );
    return { appId, key: existing?.key ?? (await issueKey(ctx, appId)) };
  },
});
