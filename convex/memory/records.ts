import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { ExecutionPayload, RecoveryMemory } from "../constants";
import { describeCheck, recoveryChecks } from "./checks";

function payloadKey(payload: ExecutionPayload) {
  return JSON.stringify({
    ...payload,
    parameters: [...payload.parameters].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    acceptanceCriteria: [...payload.acceptanceCriteria].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    checkRefs: [...payload.checkRefs].sort((a, b) =>
      a.journeyId.localeCompare(b.journeyId),
    ),
  });
}

function sameRevision(
  a: Doc<"actions">["revision"],
  b: Doc<"verifications">["revision"],
) {
  return (
    a.commitSha === b.commitSha &&
    a.buildId === b.buildId &&
    a.deploymentId === b.deploymentId
  );
}

async function outcomes(ctx: QueryCtx, row: Doc<"cases">) {
  if (row.status === "declined" || !row.signature) return [];
  const contextStep = await ctx.db
    .query("steps")
    .withIndex("by_case_and_key", (q) =>
      q.eq("caseId", row._id).eq("key", "gather_context"),
    )
    .unique();
  const context = contextStep?.currentAttemptId
    ? await ctx.db.get(contextStep.currentAttemptId)
    : null;
  if (
    contextStep?.status !== "done" ||
    context?.status !== "done" ||
    context.caseId !== row._id ||
    !context.output?.facts
  )
    return [];
  const checks = recoveryChecks(context.output.facts);
  if (!checks) return [];
  const actions = await ctx.db
    .query("actions")
    .withIndex("by_case", (q) => q.eq("caseId", row._id))
    .collect();
  const result: {
    action: Doc<"actions">;
    verification: Doc<"verifications"> | null;
    checks: NonNullable<typeof checks>;
  }[] = [];
  for (const action of actions) {
    if (
      action.status !== "completed" ||
      action.completedAt === undefined ||
      action.type !== "set_feature_flag" ||
      !Object.values(action.revision).includes(
        context.output.facts["app.revision"],
      )
    )
      continue;
    const payload = action.executionPayload;
    if (
      payload.type !== action.type ||
      payload.target.environment !== action.environment ||
      payload.parameters.length !== 2 ||
      !payload.parameters.some(
        (p) => p.name === "flag" && p.value === "recommendationsEnabled",
      ) ||
      !payload.parameters.some((p) => p.name === "value" && p.value === false)
    )
      continue;
    const catalog = await ctx.db.get(payload.actionCatalogId);
    const proposal = await ctx.db.get(action.proposalId);
    const option = proposal?.options.find((o) => o.key === action.optionKey);
    if (
      !catalog ||
      catalog.appId !== row.appId ||
      !proposal ||
      proposal.caseId !== row._id ||
      proposal.decisionStatus !== "approved" ||
      proposal.version !== action.approvedProposalVersion ||
      proposal.chosenKey !== action.optionKey ||
      !proposal.chosenBy ||
      proposal.decidedAt === undefined ||
      option?.kind !== "recovery" ||
      option.actionCatalogId !== payload.actionCatalogId ||
      payloadKey({
        ...payload,
        type: option.actionType,
        target: option.target,
        parameters: option.parameters,
        acceptanceCriteria: option.acceptanceCriteria,
        checkRefs: option.checkRefs,
      }) !== payloadKey(payload)
    )
      continue;
    const outcome = {
      action,
      verification: null as Doc<"verifications"> | null,
      checks,
    };
    result.push(outcome);
    if (!["verifying", "restored", "resolved"].includes(row.status)) continue;
    const verifications = await ctx.db
      .query("verifications")
      .withIndex("by_action", (q) => q.eq("actionId", action._id))
      .collect();
    const verification = verifications
      .filter((r) => r.phase === "after_fix")
      .sort(
        (a, b) =>
          b.completedAt - a.completedAt || b._creationTime - a._creationTime,
      )[0];
    if (
      !verification ||
      verification.caseId !== row._id ||
      verification.verdict !== "passed" ||
      verification.environment !== action.environment ||
      !sameRevision(action.revision, verification.revision) ||
      verification.startedAt < action.completedAt ||
      verification.completedAt < verification.startedAt ||
      !payload.checkRefs.some(
        (r) =>
          r.journeyId === verification.journeyId &&
          r.version === verification.checkVersion,
      ) ||
      payload.acceptanceCriteria.length === 0 ||
      verification.coverage.uncoveredCriterionIds.length > 0 ||
      verification.criterionResults.some((r) => r.status !== "passed") ||
      !payload.acceptanceCriteria.every(
        (criterion) =>
          verification.coverage.coveredCriterionIds.includes(criterion.id) &&
          verification.criterionResults.some(
            (r) => r.criterionId === criterion.id && r.status === "passed",
          ),
      )
    )
      continue;
    const attempt = await ctx.db.get(verification.stepAttemptId);
    const step = attempt ? await ctx.db.get(attempt.stepId) : null;
    if (
      !attempt ||
      attempt.caseId !== row._id ||
      attempt.status !== "done" ||
      !step ||
      step.caseId !== row._id ||
      step.purpose !== "verify" ||
      step.currentAttemptId !== attempt._id ||
      step.status !== "done"
    )
      continue;
    outcome.verification = verification;
  }
  return result;
}

export const write = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    const row = await ctx.db.get(caseId);
    if (!row)
      return { saved: false as const, reason: "The case does not exist." };
    if (row.status === "declined" || row.status === "unresolved")
      return { saved: false as const, reason: `The case is ${row.status}.` };
    const eligible = await outcomes(ctx, row);
    const source = eligible
      .filter(
        (
          outcome,
        ): outcome is typeof outcome & { verification: Doc<"verifications"> } =>
          outcome.verification !== null,
      )
      .sort((a, b) => b.action.completedAt! - a.action.completedAt!)[0];
    if (!source)
      return {
        saved: false as const,
        reason:
          "No completed recommendations recovery has a passing after-fix check for its exact environment, revision, and required criteria, with the distinguishing facts recorded.",
      };
    const candidates = await ctx.db
      .query("recoveryMemories")
      .withIndex("by_app_and_signature", (q) =>
        q.eq("appId", row.appId).eq("signature", row.signature!),
      )
      .collect();
    let existing: Doc<"recoveryMemories"> | undefined;
    for (const memory of candidates) {
      const verification = await ctx.db.get(memory.verificationId);
      const action = verification?.actionId
        ? await ctx.db.get(verification.actionId)
        : null;
      if (
        memory.actionType === source.action.type &&
        JSON.stringify(memory.conditionChecks) ===
          JSON.stringify(source.checks) &&
        action &&
        payloadKey(action.executionPayload) ===
          payloadKey(source.action.executionPayload)
      ) {
        existing = memory;
        break;
      }
    }
    const cases = await ctx.db
      .query("cases")
      .withIndex("by_app_and_signature", (q) =>
        q.eq("appId", row.appId).eq("signature", row.signature),
      )
      .collect();
    const applied = new Set<string>();
    const verified = new Set<string>();
    for (const candidate of cases) {
      for (const outcome of await outcomes(ctx, candidate)) {
        if (
          JSON.stringify(outcome.checks) === JSON.stringify(source.checks) &&
          payloadKey(outcome.action.executionPayload) ===
            payloadKey(source.action.executionPayload)
        ) {
          applied.add(outcome.action.idempotencyKey);
          if (outcome.verification) verified.add(outcome.action.idempotencyKey);
        }
      }
    }
    if (existing) {
      const changed =
        existing.timesApplied !== applied.size ||
        existing.timesVerified !== verified.size;
      await ctx.db.patch(existing._id, {
        timesApplied: applied.size,
        timesVerified: verified.size,
        sourceCaseId: caseId,
        verificationId: source.verification._id,
      });
      return {
        saved: true as const,
        created: false,
        changed,
        memoryId: existing._id,
        timesApplied: applied.size,
        timesVerified: verified.size,
      };
    }
    const notWhenChecks = source.checks.map((check) => ({
      ...check,
      operator: "neq" as const,
    }));
    const fields: RecoveryMemory = {
      appId: row.appId,
      sourceCaseId: caseId,
      signature: row.signature!,
      symptoms: `${row.title}. ${row.impact}`,
      cause:
        "The recommendations step timed out while recommendations were enabled and the service health check passed.",
      actionType: source.action.type,
      verificationId: source.verification._id,
      appRevision: String(
        source.checks.find((check) => check.field === "app.revision")!.value,
      ),
      conditions: source.checks.map(describeCheck),
      conditionChecks: source.checks,
      notWhen: notWhenChecks.map(describeCheck),
      notWhenChecks,
      timesApplied: applied.size,
      timesVerified: verified.size,
    };
    const memoryId = await ctx.db.insert("recoveryMemories", fields);
    return {
      saved: true as const,
      created: true,
      changed: true,
      memoryId,
      timesApplied: applied.size,
      timesVerified: verified.size,
    };
  },
});

export const get = internalQuery({
  args: { memoryId: v.id("recoveryMemories") },
  handler: async (ctx, { memoryId }) => await ctx.db.get(memoryId),
});

export const storeSupermemoryId = internalMutation({
  args: { memoryId: v.id("recoveryMemories"), supermemoryId: v.string() },
  handler: async (ctx, { memoryId, supermemoryId }) => {
    await ctx.db.patch(memoryId, { supermemoryId });
  },
});

export const candidates = internalQuery({
  args: {
    appId: v.id("apps"),
    signature: v.string(),
    texts: v.array(v.string()),
  },
  handler: async (ctx, { appId, signature, texts }) => {
    const rows = await ctx.db
      .query("recoveryMemories")
      .withIndex("by_app_and_signature", (q) =>
        q.eq("appId", appId).eq("signature", signature),
      )
      .collect();
    const found = new Map(rows.map((row) => [row._id, row]));
    for (const text of texts) {
      for (const match of text.matchAll(
        /Convex recovery memory: ([a-zA-Z0-9]+)/g,
      )) {
        const id = ctx.db.normalizeId("recoveryMemories", match[1]);
        const row = id ? await ctx.db.get(id) : null;
        if (row?.appId === appId) found.set(row._id, row);
      }
    }
    return await Promise.all(
      [...found.values()].map(async (memory) => {
        const sourceCase = await ctx.db.get(memory.sourceCaseId);
        const sourceVerification = await ctx.db.get(memory.verificationId);
        const evidenceValid =
          sourceCase?.appId === appId &&
          sourceVerification?.caseId === sourceCase._id &&
          sourceVerification.verdict === "passed" &&
          (await outcomes(ctx, sourceCase)).some(
            (outcome) =>
              outcome.action._id === sourceVerification.actionId &&
              outcome.verification !== null,
          );
        return { ...memory, evidenceValid };
      }),
    );
  },
});
