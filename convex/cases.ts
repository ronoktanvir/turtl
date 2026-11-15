import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cases").order("desc").collect();
  },
});

// A retry is a new step row with the next attempt number; keep only the
// highest attempt for each stage.
function currentSteps(steps: Doc<"steps">[]) {
  const latest = new Map<string, Doc<"steps">>();
  for (const step of steps) {
    const seen = latest.get(step.stage);
    if (!seen || step.attempt > seen.attempt) latest.set(step.stage, step);
  }
  return [...latest.values()];
}

// Home screen: every case, newest first, with its current steps.
export const listWithSteps = query({
  args: {},
  handler: async (ctx) => {
    const cases = await ctx.db.query("cases").order("desc").collect();
    return await Promise.all(
      cases.map(async (row) => {
        const steps = await ctx.db
          .query("steps")
          .withIndex("by_case", (q) => q.eq("caseId", row._id))
          .collect();
        return { ...row, steps: currentSteps(steps) };
      }),
    );
  },
});

// Case screen: one case with its current steps, or null when the id
// is not a case.
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("cases", args.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    const steps = await ctx.db
      .query("steps")
      .withIndex("by_case", (q) => q.eq("caseId", id))
      .collect();
    return { ...row, steps: currentSteps(steps) };
  },
});
