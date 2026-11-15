import { v } from "convex/values";
import { query } from "./_generated/server";
import { latestAction, latestProposal } from "./protectedApp/records";
import { loadSteps } from "./workflow";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cases").order("desc").collect();
  },
});

// Home screen: every case, newest first, with its steps and their current attempts.
export const listWithSteps = query({
  args: {},
  handler: async (ctx) => {
    const cases = await ctx.db.query("cases").order("desc").collect();
    return await Promise.all(
      cases.map(async (row) => ({ ...row, steps: await loadSteps(ctx, row._id) })),
    );
  },
});

// Case screen: one case with its steps, or null when the id is not a case.
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("cases", args.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    return { ...row, steps: await loadSteps(ctx, id) };
  },
});

// The six cards for one case: the case, its steps with their current attempts, evidence, the latest
// proposal, the action, verifications and agent runs. Null when the id is not a case.
export const cards = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("cases", args.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    return {
      case: row,
      journey: row.journeyId ? await ctx.db.get(row.journeyId) : null,
      steps: await loadSteps(ctx, id),
      evidence: await ctx.db
        .query("evidence")
        .withIndex("by_case", (q) => q.eq("caseId", id))
        .collect(),
      proposal: await latestProposal(ctx, id),
      action: await latestAction(ctx, id),
      verifications: await ctx.db
        .query("verifications")
        .withIndex("by_case", (q) => q.eq("caseId", id))
        .collect(),
      agentRuns: await ctx.db
        .query("agentRuns")
        .withIndex("by_case", (q) => q.eq("caseId", id))
        .collect(),
    };
  },
});
