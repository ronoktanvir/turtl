import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { CLOSED_CASE_STATUSES, type Actor, type ParameterConstraint, type Parameters } from "./constants";
import { revisionOf } from "./protectedApp/client";
import { approveCase, declineCase } from "./runner/run";
import { finishAttempt, loadSteps, setCaseStatus, skipStep } from "./workflow";

// There is no sign-in yet: every decision is recorded as the one solo owner, and anyone who has
// the deployment URL can call these two mutations.
export const SOLO_OWNER = { kind: "owner", identity: "solo-owner" } as const satisfies Actor;

async function undecidedProposal(ctx: MutationCtx, proposalId: Id<"proposals">, version: number) {
  const proposal = await ctx.db.get(proposalId);
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.version !== version) {
    throw new Error(`This proposal is version ${proposal.version}, not version ${version}.`);
  }
  const latest = await ctx.db
    .query("proposals")
    .withIndex("by_step_and_version", (q) => q.eq("stepId", proposal.stepId))
    .order("desc")
    .first();
  if (latest && latest._id !== proposal._id) {
    throw new Error(`Version ${version} is out of date: the latest proposal is version ${latest.version}.`);
  }
  if (proposal.decisionStatus !== "pending") {
    throw new Error(`This proposal was already ${proposal.decisionStatus}.`);
  }
  return proposal;
}

export function checkParameters(parameters: Parameters, constraints: ParameterConstraint[]) {
  const names = parameters.map((p) => p.name);
  if (new Set(names).size !== names.length) throw new Error("A parameter is given twice.");
  for (const parameter of parameters) {
    const constraint = constraints.find((c) => c.name === parameter.name);
    if (!constraint) throw new Error(`"${parameter.name}" is not a parameter of this action.`);
    const type = parameter.value === null ? "null" : typeof parameter.value;
    if (type !== constraint.type) throw new Error(`"${parameter.name}" must be a ${constraint.type}.`);
    if (constraint.allowedValues && !constraint.allowedValues.includes(parameter.value)) {
      throw new Error(`"${parameter.name}" may not be ${JSON.stringify(parameter.value)}.`);
    }
    if (typeof parameter.value === "number") {
      if (constraint.min !== undefined && parameter.value < constraint.min) throw new Error(`"${parameter.name}" is too small.`);
      if (constraint.max !== undefined && parameter.value > constraint.max) throw new Error(`"${parameter.name}" is too large.`);
    }
  }
  for (const constraint of constraints) {
    if (constraint.required && !names.includes(constraint.name)) {
      throw new Error(`"${constraint.name}" is required.`);
    }
  }
}

// Freezes the proposal and records the action with the payload copied from the catalog now. The owner's
// approval and a run under the owner's permission both go through here.
export async function freezeAndRecordAction(
  ctx: MutationCtx,
  proposal: Doc<"proposals">,
  optionKey: string,
  by: { actor: Actor; requestedBy: "owner" | "auto"; permissionId?: Id<"permissions"> },
) {
  const proposalId = proposal._id;
  const option = proposal.options.find((o) => o.key === optionKey);
  if (!option) throw new Error(`The proposal has no option "${optionKey}".`);
  const entry = await ctx.db.get(option.actionCatalogId);
  const row = await ctx.db.get(proposal.caseId);
  if (!entry || !row || entry.appId !== row.appId || entry.type !== option.actionType) {
    throw new Error("The option's action is not in this app's catalog.");
  }
  const app = await ctx.db.get(row.appId);
  if (!app?.productionUrl) throw new Error("The case's app has no control URL registered.");
  checkParameters(option.parameters, entry.parameterConstraints);

  const now = Date.now();
  await ctx.db.patch(proposalId, {
    decisionStatus: "approved",
    chosenKey: optionKey,
    chosenBy: by.actor,
    decidedAt: now,
  });
  const facts = (await loadSteps(ctx, proposal.caseId)).find((s) => s.purpose === "gather_context")
    ?.currentAttempt?.output?.facts as Record<string, unknown> | undefined;
  const appRevision = typeof facts?.["app.revision"] === "string" ? facts["app.revision"] : null;
  const actionId = await ctx.db.insert("actions", {
    caseId: proposal.caseId,
    proposalId,
    approvedProposalVersion: proposal.version,
    optionKey,
    type: entry.type,
    requestedBy: by.requestedBy,
    actor: by.actor,
    ...(by.permissionId && { permissionId: by.permissionId }),
    environment: option.target.environment,
    revision: revisionOf(appRevision, app.productionUrl),
    executionPayload: {
      actionCatalogId: entry._id,
      type: entry.type,
      target: option.target,
      parameters: option.parameters,
      config: entry.config,
      acceptanceCriteria: option.acceptanceCriteria,
      checkRefs: option.checkRefs,
    },
    status: "pending",
    idempotencyKey: `${proposalId}:v${proposal.version}:${optionKey}`,
    requestedAt: now,
  });
  return actionId;
}

// The owner's approval: freezes the proposal, records the action, then resumes the runner.
export const approve = mutation({
  args: { proposalId: v.id("proposals"), version: v.number(), optionKey: v.string() },
  handler: async (ctx, { proposalId, version, optionKey }) => {
    const proposal = await undecidedProposal(ctx, proposalId, version);
    const actionId = await freezeAndRecordAction(ctx, proposal, optionKey, {
      actor: SOLO_OWNER,
      requestedBy: "owner",
    });
    await approveCase(ctx, proposal.caseId);
    return { actionId };
  },
});

export const decline = mutation({
  args: { proposalId: v.id("proposals"), version: v.number() },
  handler: async (ctx, { proposalId, version }) => {
    const proposal = await undecidedProposal(ctx, proposalId, version);
    await ctx.db.patch(proposalId, {
      decisionStatus: "declined",
      chosenBy: SOLO_OWNER,
      decidedAt: Date.now(),
    });
    await declineCase(ctx, proposal.caseId);
  },
});

export const stop = mutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }): Promise<{ stopped: true; summary: string } | { stopped: false; reason: string }> => {
    const row = await ctx.db.get(caseId);
    if (!row) return { stopped: false, reason: "This case no longer exists." };
    const action = await ctx.db.query("actions").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("desc").first();
    if (!action) return { stopped: false, reason: "No approved action is running. You can decline the proposal instead." };
    if (action.status === "cancelled") return { stopped: true, summary: action.result ?? "The owner already stopped this action." };
    if ((CLOSED_CASE_STATUSES as readonly string[]).includes(row.status)) {
      return { stopped: false, reason: "This case has already finished." };
    }
    const pulls = await ctx.db.query("pullRequests").withIndex("by_action", (q) => q.eq("actionId", action._id)).collect();
    const codeChange = action.executionPayload.config.kind === "capy";
    if (codeChange && (action.status === "completed" || pulls.some((p) => p.mergedAt !== undefined || p.snapshot?.state === "merged" || p.mergeRequestedAt !== undefined))) {
      return { stopped: false, reason: "The pull request was already merged or its merge was requested. Stopping cannot undo it; deployment tracking and verification will continue." };
    }
    if (!codeChange && action.status !== "pending") {
      return { stopped: false, reason: "The change has already started sending to the live app and may have taken effect. Stopping cannot undo it; verification will continue." };
    }
    const now = Date.now();
    const pull = pulls[0];
    const left = codeChange && action.status !== "pending"
      ? pull?.number !== undefined
        ? ` Pull request #${pull.number} remains on GitHub. turtl will not follow or merge it; close it on GitHub if you no longer want it.`
        : " Capy may still be writing a pull request. turtl will not follow or merge it; any branch or pull request it creates remains on GitHub."
      : " Nothing was sent to the live app.";
    const summary = `The owner stopped this action.${left}`;
    await ctx.db.patch(action._id, { status: "cancelled", cancelledBy: SOLO_OWNER, cancelledAt: now, completedAt: now, result: summary });
    for (const pending of pulls) await ctx.db.patch(pending._id, { settledAt: now, openError: summary, syncError: undefined });
    const steps = await loadSteps(ctx, caseId);
    const ids = new Set<string>([caseId, action._id, ...steps.flatMap((s) => s.currentAttemptId ? [s.currentAttemptId] : []), ...pulls.map((p) => p._id)]);
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of scheduled) {
      const args = job.args[0] as Record<string, unknown> | undefined;
      if (job.state.kind === "pending" && args && Object.values(args).some((value) => typeof value === "string" && ids.has(value))) {
        await ctx.scheduler.cancel(job._id);
      }
    }
    for (const step of steps) {
      if ((step.status === "running" || step.status === "waiting") && step.currentAttemptId) {
        await finishAttempt(ctx, step.currentAttemptId, { status: "done", summary });
      }
    }
    await setCaseStatus(ctx, caseId, "declined");
    for (const step of steps) {
      if (step.status === "pending" || step.status === "failed") await skipStep(ctx, step._id, summary);
    }
    return { stopped: true, summary };
  },
});
