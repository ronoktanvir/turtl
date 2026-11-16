import { mutation } from "../_generated/server";
import { requireDevTools } from "../access";
import { registerCodeChangeAction } from "../prTracking/catalog";
import { registerBookingApp } from "../protectedApp/registry";
import { issueKey } from "./keys";

// Dev tools: registers the booking app with its pull request action and returns its intake key, issuing
// one the first time. Needs DEV_TOOLS_ENABLED=true and PROTECTED_APP_URL, and is closed with accounts on.
export const bookingKey = mutation({
  args: {},
  handler: async (ctx) => {
    requireDevTools();
    const { appId } = await registerBookingApp(ctx);
    await registerCodeChangeAction(ctx);
    const existing = (await ctx.db.query("intakeKeys").withIndex("by_app", (q) => q.eq("appId", appId)).collect()).find(
      (row) => row.revokedAt === undefined,
    );
    return { appId, key: existing?.key ?? (await issueKey(ctx, appId)) };
  },
});
