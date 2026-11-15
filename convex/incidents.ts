import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("incidents").order("desc").collect();
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

// Home screen: every incident, newest first, with its current steps.
export const listWithSteps = query({
  args: {},
  handler: async (ctx) => {
    const incidents = await ctx.db.query("incidents").order("desc").collect();
    return await Promise.all(
      incidents.map(async (incident) => {
        const steps = await ctx.db
          .query("steps")
          .withIndex("by_incident", (q) => q.eq("incidentId", incident._id))
          .collect();
        return { ...incident, steps: currentSteps(steps) };
      }),
    );
  },
});

// Incident screen: one incident with its current steps, or null when the id
// is not an incident.
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("incidents", args.id);
    if (!id) return null;
    const incident = await ctx.db.get(id);
    if (!incident) return null;
    const steps = await ctx.db
      .query("steps")
      .withIndex("by_incident", (q) => q.eq("incidentId", id))
      .collect();
    return { ...incident, steps: currentSteps(steps) };
  },
});
