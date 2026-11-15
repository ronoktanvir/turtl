import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { vCriterion, vEvidence, vProposalOption, vVerification } from "../constants";
import { loadSteps } from "../workflow";

// Rows the incident handlers write: evidence, verifications, proposals, and the action's lifecycle.

async function requireAttempt(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  stepAttemptId: Id<"stepAttempts">,
  stepId?: Id<"steps">,
) {
  const attempt = await ctx.db.get(stepAttemptId);
  if (!attempt || attempt.caseId !== caseId || (stepId && attempt.stepId !== stepId)) {
    throw new Error("The step attempt does not belong to this case.");
  }
  return attempt;
}

export const addEvidence = internalMutation({
  args: { rows: v.array(vEvidence) },
  handler: async (ctx, { rows }) => {
    const ids: Id<"evidence">[] = [];
    for (const row of rows) {
      await requireAttempt(ctx, row.caseId, row.stepAttemptId, row.stepId);
      ids.push(await ctx.db.insert("evidence", row));
    }
    return ids;
  },
});

export const addVerification = internalMutation({
  args: { row: vVerification },
  handler: async (ctx, { row }) => {
    await requireAttempt(ctx, row.caseId, row.stepAttemptId);
    return await ctx.db.insert("verifications", row);
  },
});

export async function latestProposal(ctx: QueryCtx, caseId: Id<"cases">) {
  const proposals = await ctx.db
    .query("proposals")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .collect();
  return proposals.reduce<(typeof proposals)[number] | null>(
    (latest, row) => (!latest || row.version > latest.version ? row : latest),
    null,
  );
}

export const latestAction = (ctx: QueryCtx, caseId: Id<"cases">) =>
  ctx.db
    .query("actions")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .order("desc")
    .first();

// Everything a handler needs about its case, read in one query.
export const caseContext = internalQuery({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const row = await ctx.db.get(caseId);
    if (!row) throw new Error("Case not found.");
    const app = await ctx.db.get(row.appId);
    const journey = row.journeyId ? await ctx.db.get(row.journeyId) : null;
    const catalog = await ctx.db
      .query("actionCatalog")
      .withIndex("by_app_and_type", (q) => q.eq("appId", row.appId))
      .collect();
    const steps = await loadSteps(ctx, caseId);
    const evidence = await ctx.db
      .query("evidence")
      .withIndex("by_case", (q) => q.eq("caseId", caseId))
      .collect();
    return {
      case: row,
      app,
      journey,
      catalog,
      steps,
      evidence,
      proposal: await latestProposal(ctx, caseId),
      action: await latestAction(ctx, caseId),
    };
  },
});

export const writeProposal = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    options: v.array(vProposalOption),
    doneMeans: v.array(vCriterion),
  },
  handler: async (ctx, { caseId, stepId, options, doneMeans }) => {
    const step = await ctx.db.get(stepId);
    if (!step || step.caseId !== caseId) throw new Error("The step does not belong to this case.");
    const keys = new Set(options.map((o) => o.key));
    if (keys.size !== options.length) throw new Error("Option keys must be unique.");
    for (const option of options) {
      const entry = await ctx.db.get(option.actionCatalogId);
      if (!entry || entry.type !== option.actionType) {
        throw new Error(`Option "${option.key}" does not come from this app's action catalog.`);
      }
    }
    const last = await ctx.db
      .query("proposals")
      .withIndex("by_step_and_version", (q) => q.eq("stepId", stepId))
      .order("desc")
      .first();
    return await ctx.db.insert("proposals", {
      caseId,
      stepId,
      version: (last?.version ?? 0) + 1,
      decisionStatus: "pending",
      options,
      doneMeans,
    });
  },
});

// Before sending anything: a pending action is sent; one that ran before with no clear outcome is reconciled first.
export const claimAction = internalMutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("Action not found.");
    if (action.status === "completed") return { mode: "completed" as const, action };
    if (action.status === "cancelled") return { mode: "cancelled" as const, action };
    if (action.status === "pending") {
      await ctx.db.patch(actionId, { status: "running", startedAt: Date.now() });
      return { mode: "send" as const, action };
    }
    return { mode: "reconcile" as const, action };
  },
});

export const finishAction = internalMutation({
  args: {
    actionId: v.id("actions"),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("unknown"), v.literal("running")),
    result: v.string(),
    externalRef: v.optional(v.string()),
  },
  handler: async (ctx, { actionId, status, result, externalRef }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("Action not found.");
    if (action.status === "completed" || action.status === "cancelled") {
      throw new Error(`The action is already ${action.status}.`);
    }
    await ctx.db.patch(actionId, {
      status,
      result,
      ...(externalRef !== undefined && { externalRef }),
      ...((status === "completed" || status === "failed") && { completedAt: Date.now() }),
    });
  },
});
