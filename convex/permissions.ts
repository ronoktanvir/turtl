import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Actor, ParameterConstraint } from "./constants";
import { checkParameters, freezeAndRecordAction, SOLO_OWNER } from "./decisions";
import { evaluateCheck } from "./memory/checks";
import { latestAction, latestProposal } from "./protectedApp/records";
import { loadSteps } from "./workflow";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MIN_VERIFIED_RECOVERIES = 2;
export const NOT_RUN_PREFIX = "turtl did not run it on its own under your permission: ";

const short = (revision: string | undefined) => (revision ?? "unknown").slice(0, 7);

export const isActive = (permission: Doc<"permissions">, now: number) =>
  permission.revokedAt === undefined &&
  (permission.expiresAt === undefined || permission.expiresAt > now);

export async function permissionsFor(ctx: QueryCtx, memory: Doc<"recoveryMemories">) {
  const rows = await ctx.db
    .query("permissions")
    .withIndex("by_app", (q) => q.eq("appId", memory.appId))
    .collect();
  return rows.filter((p) => p.memoryId === memory._id).sort((a, b) => b.grantedAt - a.grantedAt);
}

// Uses of a permission, oldest first: one per idempotency key, so a retry of the same action counts
// once, and failed and unknown outcomes count like any other.
export async function usesOf(ctx: QueryCtx, permissionId: Id<"permissions">) {
  const actions = await ctx.db
    .query("actions")
    .withIndex("by_permission", (q) => q.eq("permissionId", permissionId))
    .collect();
  return [...new Set(actions.sort((a, b) => a.requestedAt - b.requestedAt).map((a) => a.idempotencyKey))];
}

// The permission that can still run for this memory: not revoked, not expired, and not used up.
export async function currentPermission(ctx: QueryCtx, memory: Doc<"recoveryMemories">, now: number) {
  for (const permission of await permissionsFor(ctx, memory)) {
    if (isActive(permission, now) && (await usesOf(ctx, permission._id)).length < permission.maxAttempts) {
      return permission;
    }
  }
  return null;
}

// The verified action the memory was learned from: its exact target and values are what a permission pins.
export async function sourceAction(ctx: QueryCtx, memory: Doc<"recoveryMemories">) {
  const verification = await ctx.db.get(memory.verificationId);
  const action = verification?.actionId ? await ctx.db.get(verification.actionId) : null;
  return action && action.type === memory.actionType ? action : null;
}

const autoActor = (permissionId: Id<"permissions">): Actor => ({
  kind: "auto",
  identity: `permission:${permissionId}`,
});

const factsOf = (steps: Awaited<ReturnType<typeof loadSteps>>) =>
  (steps.find((s) => s.purpose === "gather_context")?.currentAttempt?.output as
    | { facts?: Record<string, unknown> }
    | undefined)?.facts ?? {};

export const grant = mutation({
  args: { memoryId: v.id("recoveryMemories") },
  handler: async (ctx, { memoryId }) => {
    const memory = await ctx.db.get(memoryId);
    if (!memory) throw new Error("Recovery memory not found.");
    if (memory.invalidatedAt !== undefined) throw new Error("This recovery memory has been invalidated.");
    if (memory.timesVerified < MIN_VERIFIED_RECOVERIES) {
      throw new Error(
        `This recovery has been verified ${memory.timesVerified} time${memory.timesVerified === 1 ? "" : "s"}; a permission needs at least ${MIN_VERIFIED_RECOVERIES}.`,
      );
    }
    const now = Date.now();
    if (await currentPermission(ctx, memory, now)) {
      throw new Error("This recovery already has an active permission.");
    }
    if (!memory.appRevision) throw new Error("This recovery memory has no app revision to pin the permission to.");
    const action = await sourceAction(ctx, memory);
    if (!action) throw new Error("The verified action behind this recovery memory was not found.");
    const parameterConstraints: ParameterConstraint[] = action.executionPayload.parameters.map((p) => ({
      name: p.name,
      type: p.value === null ? "null" : (typeof p.value as "string" | "number" | "boolean"),
      required: true,
      allowedValues: [p.value],
    }));
    return await ctx.db.insert("permissions", {
      appId: memory.appId,
      memoryId,
      actionType: memory.actionType,
      grantedBy: SOLO_OWNER,
      grantedAt: now,
      scope: action.executionPayload.target,
      parameterConstraints,
      conditions: memory.conditions,
      conditionChecks: memory.conditionChecks,
      notWhen: memory.notWhen,
      notWhenChecks: memory.notWhenChecks,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      grantedAtRevision: memory.appRevision,
    });
  },
});

export const revoke = mutation({
  args: { permissionId: v.id("permissions") },
  handler: async (ctx, { permissionId }) => {
    const permission = await ctx.db.get(permissionId);
    if (!permission) throw new Error("Permission not found.");
    if (!isActive(permission, Date.now())) throw new Error("This permission has already ended.");
    await ctx.db.patch(permissionId, { revokedAt: Date.now(), endedReason: "You revoked it." });
  },
});

// Decides, at the approval step and before the case waits for the owner, whether the owner's permission
// covers this case. When every check holds, the proposal is frozen as decided under the permission and the
// action is recorded with its permissionId; the caller then runs execute and verify as after an approval.
// Returns null when no permission is involved, else whether it ran and, if not, why.
export async function runUnderPermission(
  ctx: MutationCtx,
  caseId: Id<"cases">,
): Promise<null | { ran: true; use: number; of: number } | { ran: false; reasons: string[] }> {
  const row = await ctx.db.get(caseId);
  if (!row) return null;
  const now = Date.now();
  const facts = factsOf(await loadSteps(ctx, caseId));
  const revision = facts["app.revision"];
  const memory = row.matchedMemoryId ? await ctx.db.get(row.matchedMemoryId) : null;
  if (!memory) {
    // No remembered recovery matched, so no permission covers this case. Say so when one exists for this
    // kind of failure, and end it if the app's revision has moved on.
    const reasons: string[] = [];
    const all = await ctx.db
      .query("permissions")
      .withIndex("by_app", (q) => q.eq("appId", row.appId))
      .collect();
    for (const permission of all.filter((p) => isActive(p, now))) {
      const source = permission.memoryId ? await ctx.db.get(permission.memoryId) : null;
      if (source?.signature !== row.signature) continue;
      if (typeof revision === "string" && revision && revision !== permission.grantedAtRevision) {
        const endedReason = `The booking app moved to a new version (${short(permission.grantedAtRevision)} → ${short(revision)}) after you granted it.`;
        await ctx.db.patch(permission._id, { expiresAt: now, endedReason });
        reasons.push(`Your permission ended: ${endedReason}`);
      } else {
        reasons.push("No saved recovery fits this failure, so your permission does not cover it.");
      }
    }
    return reasons.length ? { ran: false, reasons: [...new Set(reasons)] } : null;
  }
  const [permission] = await permissionsFor(ctx, memory);
  if (!permission) return null;

  const reasons: string[] = [];
  if (permission.revokedAt !== undefined) {
    reasons.push(`Your permission was revoked: ${permission.endedReason ?? "no reason recorded."}`);
  } else if (permission.expiresAt !== undefined && permission.expiresAt <= now) {
    reasons.push(`Your permission ended: ${permission.endedReason ?? "it expired."}`);
  } else if (typeof revision !== "string" || !revision) {
    reasons.push("The booking app's revision was not observed, so it could not be matched to your permission.");
  } else if (revision !== permission.grantedAtRevision) {
    const endedReason = `The booking app moved to a new version (${short(permission.grantedAtRevision)} → ${short(revision)}) after you granted it.`;
    await ctx.db.patch(permission._id, { expiresAt: now, endedReason });
    reasons.push(`Your permission ended: ${endedReason}`);
  }
  if (reasons.length === 0) {
    for (const check of permission.conditionChecks) {
      const result = evaluateCheck(check, facts);
      if (!result.matches) reasons.push(`A required condition does not hold: ${result.reason}`);
    }
    for (const check of permission.notWhenChecks) {
      const result = evaluateCheck(check, facts);
      if (result.matches || result.unknown) reasons.push(`A blocking condition applies: ${result.reason}`);
    }
  }
  const proposal = await latestProposal(ctx, caseId);
  const option = proposal?.options.find((o) => o.recommended);
  if (!proposal || proposal.decisionStatus !== "pending") {
    reasons.push("There is no undecided proposal.");
  } else if (!option) {
    reasons.push("No option is recommended.");
  } else if (option.actionType !== permission.actionType) {
    reasons.push(`The recommended action is "${option.title}", not the action your permission names.`);
  } else if (
    option.target.environment !== permission.scope.environment ||
    option.target.resourceRef !== permission.scope.resourceRef
  ) {
    reasons.push("The recommended action targets something other than what your permission names.");
  } else {
    try {
      checkParameters(option.parameters, permission.parameterConstraints);
    } catch (error) {
      reasons.push(`The recommended values differ from your permission: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const uses = await usesOf(ctx, permission._id);
  if (uses.length >= permission.maxAttempts && isActive(permission, now)) {
    reasons.push(`Your permission has been used ${uses.length} of ${permission.maxAttempts} times.`);
  }
  if (reasons.length > 0 || !proposal || !option) return { ran: false, reasons };

  await freezeAndRecordAction(ctx, proposal, option.key, {
    actor: autoActor(permission._id),
    requestedBy: "auto",
    permissionId: permission._id,
  });
  if (uses.length + 1 >= permission.maxAttempts) {
    await ctx.db.patch(permission._id, {
      expiresAt: now,
      endedReason: `It was used all ${permission.maxAttempts} times.`,
    });
  }
  return { ran: true, use: uses.length + 1, of: permission.maxAttempts };
}

// After a run under a permission ends: a restored case tells the owner what turtl did on its own; any other
// end revokes the permission, so the next failure asks the owner.
export async function settlePermissionRun(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  outcome: { status: "restored"; check: string } | { status: "unresolved" },
) {
  const action = await latestAction(ctx, caseId);
  if (!action?.permissionId) return;
  const permission = await ctx.db.get(action.permissionId);
  const row = await ctx.db.get(caseId);
  if (!permission || !row) return;
  if (outcome.status === "restored") {
    const uses = await usesOf(ctx, permission._id);
    await ctx.scheduler.runAfter(0, internal.notices.notifyOwner, {
      caseId,
      event: "handled_under_permission",
      text: `turtl handled "${row.title}" on its own under your permission (use ${uses.indexOf(action.idempotencyKey) + 1} of ${permission.maxAttempts}). What it did: ${(action.result ?? action.type).replace(/\.$/, "")}. The check afterwards: ${outcome.check}`,
    });
    return;
  }
  if (permission.revokedAt !== undefined) return;
  await ctx.db.patch(permission._id, {
    revokedAt: Date.now(),
    endedReason: `A run under it did not restore service ("${row.title}" ended unresolved), so turtl asks you next time.`,
  });
}

