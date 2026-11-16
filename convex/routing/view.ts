import { v } from "convex/values";
import { query } from "../_generated/server";
import { canSeeCase } from "../access";

// Read-only: who worked on each step of a case and why, and the council's consolidated view. With accounts on, only
// for the owner of the case's project.
export const forCase = query({
  args: { caseId: v.string() },
  handler: async (ctx, args) => {
    if (!(await canSeeCase(ctx, args.caseId))) return null;
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId || !(await ctx.db.get(caseId))) return null;
    const steps = await ctx.db.query("steps").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
    const runs = await ctx.db.query("agentRuns").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
    const reviews = await ctx.db.query("councilReviews").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
    const council = reviews.filter((review) => review.status !== "skipped").sort((a, b) => b.startedAt - a.startedAt)[0]
      ?? reviews.sort((a, b) => b.startedAt - a.startedAt)[0]
      ?? null;
    return { steps: steps.map((step) => ({ _id: step._id, key: step.key })), runs, council };
  },
});
