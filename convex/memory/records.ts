import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { Condition, ExecutionPayload, RecoveryMemory } from "../constants";
import { vParameterValue } from "../constants";
import { CRITERIA } from "../protectedApp/client";
import {
  applicability,
  describeCheck,
  diagnosisChecks,
  recoveryChecks,
} from "./checks";

/** A signature's newest cases read to count a memory's uses: one journey's failures, which the monitor can keep opening. */
const SIGNATURE_CASES_READ = 500;
/** A case's first actions, and an action's newest verifications, read: as many as the owner approves and turtl retries. */
const PER_CASE_READ = 50;
/** A signature's memories read: one per distinct recovery (action, conditions, parameters), so few; a bound all the same. */
const MEMORIES_READ = 200;

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

function checksKey(checks: Condition[]) {
  return JSON.stringify(
    [...checks].sort(
      (a, b) =>
        a.field.localeCompare(b.field) ||
        a.operator.localeCompare(b.operator) ||
        JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)),
    ),
  );
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

function criterionSnapshot(
  action: Doc<"actions">,
  verification: Doc<"verifications">,
) {
  return action.executionPayload.acceptanceCriteria.map((criterion) => {
    const result = verification.criterionResults.find(
      (result) => result.criterionId === criterion.id,
    );
    if (
      !result ||
      verification.coverage.uncoveredCriterionIds.includes(criterion.id) ||
      !verification.coverage.coveredCriterionIds.includes(criterion.id)
    )
      return {
        criterionId: criterion.id,
        status: "uncovered" as const,
        summary:
          result?.status === "uncovered"
            ? result.summary
            : "Not covered by the source verification.",
        evidenceIds: result?.evidenceIds ?? [],
      };
    return result;
  });
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
  const facts = context.output.facts;
  const investigation = await ctx.db
    .query("steps")
    .withIndex("by_case_and_key", (q) =>
      q.eq("caseId", row._id).eq("key", "investigate"),
    )
    .unique();
  const investigated = investigation?.currentAttemptId
    ? await ctx.db.get(investigation.currentAttemptId)
    : null;
  const diagnosis =
    investigated?.status === "done"
      ? (investigated.output?.diagnosis as
          | { cause?: string; supportingFactKeys?: unknown }
          | undefined)
      : undefined;
  let checks = diagnosisChecks(facts, diagnosis?.supportingFactKeys);
  let conditionSource: "diagnosis" | "fallback" = checks
    ? "diagnosis"
    : "fallback";
  let cause =
    checks && typeof diagnosis?.cause === "string" && diagnosis.cause.trim()
      ? diagnosis.cause
      : "Fallback fact pattern: recommendations timed out while enabled and the service health check passed. No diagnosis supplied usable supporting fact keys.";
  if (row.matchedMemoryId) {
    const memory = await ctx.db.get(row.matchedMemoryId);
    if (
      !memory ||
      memory.appId !== row.appId ||
      memory.signature !== row.signature ||
      !applicability(memory, facts).applies
    )
      return [];
    checks = memory.conditionChecks;
    conditionSource = memory.conditionSource ?? "fallback";
    cause = memory.cause;
  } else checks ??= recoveryChecks(facts);
  if (!checks) return [];
  const actions = await ctx.db
    .query("actions")
    .withIndex("by_case", (q) => q.eq("caseId", row._id))
    .take(PER_CASE_READ);
  const result: {
    action: Doc<"actions">;
    verification: Doc<"verifications"> | null;
    checks: NonNullable<typeof checks>;
    cause: string;
    conditionSource: "diagnosis" | "fallback";
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
      cause,
      conditionSource,
    };
    result.push(outcome);
    if (!["verifying", "restored", "resolved"].includes(row.status)) continue;
    const verifications = await ctx.db
      .query("verifications")
      .withIndex("by_action", (q) => q.eq("actionId", action._id))
      .order("desc")
      .take(PER_CASE_READ);
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
      verification.criterionResults.some((r) => r.status === "failed") ||
      !payload.acceptanceCriteria.some(
        (criterion) => criterion.id === CRITERIA.journey.id,
      ) ||
      !verification.coverage.coveredCriterionIds.includes(
        CRITERIA.journey.id,
      ) ||
      verification.coverage.uncoveredCriterionIds.includes(
        CRITERIA.journey.id,
      ) ||
      !verification.criterionResults.some(
        (r) => r.criterionId === CRITERIA.journey.id && r.status === "passed",
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
      .take(MEMORIES_READ);
    let existing: Doc<"recoveryMemories"> | undefined;
    for (const memory of candidates) {
      const verification = await ctx.db.get(memory.verificationId);
      const action = verification?.actionId
        ? await ctx.db.get(verification.actionId)
        : null;
      if (
        memory.actionType === source.action.type &&
        checksKey(memory.conditionChecks) === checksKey(source.checks) &&
        action &&
        payloadKey(action.executionPayload) ===
          payloadKey(source.action.executionPayload)
      ) {
        existing = memory;
        break;
      }
    }
    // The signature's newest SIGNATURE_CASES_READ cases: one journey's failures, which the monitor can open again and
    // again. Past that many the counts below cover the newest ones, and an existing memory keeps its larger counts.
    const cases = await ctx.db
      .query("cases")
      .withIndex("by_app_and_signature", (q) =>
        q.eq("appId", row.appId).eq("signature", row.signature),
      )
      .order("desc")
      .take(SIGNATURE_CASES_READ);
    const windowFull = cases.length === SIGNATURE_CASES_READ;
    const applied = new Set<string>();
    const verified = new Set<string>();
    for (const candidate of cases) {
      for (const outcome of await outcomes(ctx, candidate)) {
        if (
          checksKey(outcome.checks) === checksKey(source.checks) &&
          payloadKey(outcome.action.executionPayload) ===
            payloadKey(source.action.executionPayload)
        ) {
          applied.add(outcome.action.idempotencyKey);
          if (outcome.verification) verified.add(outcome.action.idempotencyKey);
        }
      }
    }
    if (existing) {
      const timesApplied = windowFull ? Math.max(existing.timesApplied, applied.size) : applied.size;
      const timesVerified = windowFull ? Math.max(existing.timesVerified, verified.size) : verified.size;
      const changed =
        existing.timesApplied !== timesApplied ||
        existing.timesVerified !== timesVerified;
      await ctx.db.patch(existing._id, {
        timesApplied,
        timesVerified,
        sourceCaseId: caseId,
        verificationId: source.verification._id,
        criterionResults: criterionSnapshot(source.action, source.verification),
        conditionSource: source.conditionSource,
        cause: source.cause,
      });
      return {
        saved: true as const,
        created: false,
        changed,
        memoryId: existing._id,
        timesApplied,
        timesVerified,
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
      cause: source.cause,
      conditionSource: source.conditionSource,
      criterionResults: criterionSnapshot(source.action, source.verification),
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

export async function sourceEvidenceValid(
  ctx: QueryCtx,
  memory: Doc<"recoveryMemories">,
) {
  const sourceCase = await ctx.db.get(memory.sourceCaseId);
  const sourceVerification = await ctx.db.get(memory.verificationId);
  return (
    sourceCase?.appId === memory.appId &&
    sourceVerification?.caseId === sourceCase._id &&
    sourceVerification.verdict === "passed" &&
    (await outcomes(ctx, sourceCase)).some(
      (outcome) =>
        outcome.action._id === sourceVerification.actionId &&
        outcome.verification !== null,
    )
  );
}

export const remembered = internalQuery({
  args: { caseId: v.id("cases"), facts: v.record(v.string(), vParameterValue) },
  handler: async (ctx, { caseId, facts }) => {
    const row = await ctx.db.get(caseId);
    const memory = row?.matchedMemoryId
      ? await ctx.db.get(row.matchedMemoryId)
      : null;
    if (
      !row ||
      !memory ||
      memory.appId !== row.appId ||
      memory.signature !== row.signature ||
      !applicability(memory, facts).applies ||
      !(await sourceEvidenceValid(ctx, memory))
    )
      return null;
    const verification = await ctx.db.get(memory.verificationId);
    const action = verification?.actionId
      ? await ctx.db.get(verification.actionId)
      : null;
    const proposal = action ? await ctx.db.get(action.proposalId) : null;
    const option = proposal?.options.find(
      (option) => option.key === action?.optionKey,
    );
    return action && verification && option
      ? { memory, verification, action, option }
      : null;
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
      .take(MEMORIES_READ);
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
        const evidenceValid = await sourceEvidenceValid(ctx, memory);
        return { ...memory, evidenceValid };
      }),
    );
  },
});
