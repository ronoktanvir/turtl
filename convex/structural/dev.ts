import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireDevTools } from "../access";

// Dev tools: removes an app's structural findings and the prevention checks registered from them, so the
// booking demo can be reset (dev:resetBooking needs every journey of the app to pass, and a prevention check
// fails by design while the defect it guards against is live). Cases the checks opened are left to that reset.
// Closed unless DEV_TOOLS_ENABLED=true, and always closed with accounts on (convex/access.ts).
export const clear = mutation({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    requireDevTools();
    const findings = await ctx.db
      .query("structuralFindings")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    let checks = 0;
    for (const finding of findings) {
      if (finding.check?.journeyId && (await ctx.db.get(finding.check.journeyId))) {
        await ctx.db.delete(finding.check.journeyId);
        checks++;
      }
      await ctx.db.delete(finding._id);
    }
    return { summary: `Removed ${findings.length} structural finding(s) and ${checks} prevention check(s). Cases those checks opened were not changed.` };
  },
});
