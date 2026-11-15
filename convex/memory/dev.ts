import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  createCaseFromTemplate,
  finishAttempt,
  loadSteps,
  setCaseStatus,
  startAttempt,
} from "../workflow";
import { applicability, evaluateCheck } from "./checks";
import { handler as learnHandler } from "../runner/handlers/learn";

declare const process: { env: Record<string, string | undefined> };

function requireDev() {
  if (process.env.DEV_TOOLS_ENABLED !== "true")
    throw new Error("Development tools are disabled.");
}

const facts = {
  "journey.verdict": "failed",
  "journey.failedStep": "recommendations",
  "journey.errorCode": "RECOMMENDATIONS_TIMEOUT",
  "flags.recommendationsEnabled": true,
  "health.ok": true,
  "app.revision": "memory-fixture-v1",
};

export const seed = internalMutation({
  args: {
    appId: v.optional(v.id("apps")),
    outcome: v.union(
      v.literal("verified"),
      v.literal("unverified"),
      v.literal("declined"),
      v.literal("unresolved"),
      v.literal("wrong_revision"),
      v.literal("uncovered"),
      v.literal("latest_failed"),
    ),
  },
  handler: async (ctx, { appId, outcome }) => {
    requireDev();
    appId ??= await ctx.db.insert("apps", {
      name: "Staged recovery memory evidence",
      revision: "memory-fixture-v1",
    });
    let journey = await ctx.db
      .query("journeys")
      .withIndex("by_app", (q) => q.eq("appId", appId!))
      .first();
    if (!journey) {
      const id = await ctx.db.insert("journeys", {
        appId,
        name: "Staged booking journey",
        description: "Fixture only; no network requests are made.",
        checkVersion: "1",
        check: {
          kind: "http",
          config: {
            url: "https://example.invalid/check",
            method: "GET",
            expectedStatus: 200,
          },
        },
      });
      journey = (await ctx.db.get(id))!;
    }
    let catalog = await ctx.db
      .query("actionCatalog")
      .withIndex("by_app_and_type", (q) =>
        q.eq("appId", appId!).eq("type", "set_feature_flag"),
      )
      .first();
    if (!catalog) {
      const id = await ctx.db.insert("actionCatalog", {
        appId,
        type: "set_feature_flag",
        name: "Disable recommendations",
        description: "Staged fixture only",
        reversible: true,
        config: {
          kind: "http",
          url: "https://example.invalid/flags",
          method: "POST",
        },
        parameterConstraints: [],
      });
      catalog = (await ctx.db.get(id))!;
    }
    const signature = `journey_failed:${journey._id}`;
    const caseId = await createCaseFromTemplate(ctx, {
      appId,
      title: "Staged booking recommendations timed out",
      impact: "Customers cannot complete a booking.",
      kind: "outage",
      raisedBy: "owner",
      signature,
    });
    await ctx.db.patch(caseId, { journeyId: journey._id });
    let planStepId: Id<"steps"> | undefined;
    let verifyAttemptId: Id<"stepAttempts"> | undefined;
    for (const step of await loadSteps(ctx, caseId)) {
      if (step.purpose === "learn") break;
      const attemptId = await startAttempt(ctx, step._id);
      await finishAttempt(ctx, attemptId, {
        status: "done",
        summary: "Staged fixture; not an actual protected-app run.",
        ...(step.purpose === "gather_context" ? { output: { facts } } : {}),
      });
      if (step.purpose === "plan") planStepId = step._id;
      if (step.purpose === "verify") verifyAttemptId = attemptId;
    }
    const criteria = [
      { id: "booking", description: "The booking journey passes." },
    ];
    const target = {
      environment: "production",
      resourceRef: "recommendationsEnabled",
    };
    const parameters = [
      { name: "flag", value: "recommendationsEnabled" },
      { name: "value", value: false },
    ];
    const checkRefs = [{ journeyId: journey._id, version: "1" }];
    const now = Date.now();
    const proposalId = await ctx.db.insert("proposals", {
      caseId,
      stepId: planStepId!,
      version: 1,
      decisionStatus: outcome === "declined" ? "declined" : "approved",
      chosenKey: "disable",
      chosenBy: { kind: "owner", identity: "staged-fixture-owner" },
      decidedAt: now,
      doneMeans: criteria,
      options: [
        {
          key: "disable",
          title: "Disable optional recommendations",
          kind: "recovery",
          actionType: "set_feature_flag",
          actionCatalogId: catalog._id,
          target,
          parameters,
          acceptanceCriteria: criteria,
          checkRefs,
          whatChanges: "Disable optional recommendations.",
          whatMightBeLost: "Suggested extras are hidden.",
          howChecked: "Run the booking journey again.",
          evidenceIds: [],
          recommended: true,
          confidence: 1,
        },
      ],
    });
    const actionId = await ctx.db.insert("actions", {
      caseId,
      proposalId,
      approvedProposalVersion: 1,
      optionKey: "disable",
      type: "set_feature_flag",
      requestedBy: "owner",
      actor: { kind: "owner", identity: "staged-fixture-owner" },
      environment: "production",
      revision: { deploymentId: "memory-fixture-v1" },
      executionPayload: {
        actionCatalogId: catalog._id,
        type: "set_feature_flag",
        target,
        parameters,
        config: catalog.config,
        acceptanceCriteria: criteria,
        checkRefs,
      },
      status: outcome === "declined" ? "cancelled" : "completed",
      idempotencyKey: `staged-memory:${caseId}`,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
    });
    const verification = {
      caseId,
      journeyId: journey._id,
      actionId,
      stepAttemptId: verifyAttemptId!,
      environment: "production",
      revision: { deploymentId: "memory-fixture-v1" },
      checkVersion: "1",
      criteriaVersion: "1",
      criterionResults: [
        {
          criterionId: "booking",
          status: "passed" as const,
          summary: "Staged passing criterion",
          evidenceIds: [],
        },
      ],
      evidenceIds: [],
      startedAt: now,
      completedAt: now,
      coverage: { coveredCriterionIds: ["booking"], uncoveredCriterionIds: [] },
      summary: "Staged verification fixture, not live evidence.",
    };
    await ctx.db.insert("verifications", {
      ...verification,
      phase: "before",
      verdict: "failed",
    });
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert("verifications", {
        ...verification,
        phase: "after_fix",
        verdict: outcome === "unverified" ? "inconclusive" : "passed",
        completedAt: now + i,
        ...(outcome === "wrong_revision"
          ? { revision: { deploymentId: "another-build" } }
          : {}),
        ...(outcome === "uncovered"
          ? {
              coverage: {
                coveredCriterionIds: [],
                uncoveredCriterionIds: ["booking"],
              },
              criterionResults: [
                {
                  criterionId: "booking",
                  status: "uncovered",
                  summary: "Staged uncovered criterion",
                  evidenceIds: [],
                },
              ],
            }
          : {}),
      });
    }
    if (outcome === "latest_failed")
      await ctx.db.insert("verifications", {
        ...verification,
        phase: "after_fix",
        verdict: "failed",
        completedAt: now + 3,
      });
    await setCaseStatus(
      ctx,
      caseId,
      outcome === "declined"
        ? "declined"
        : outcome === "unresolved"
          ? "unresolved"
          : "restored",
    );
    return { appId, caseId, signature };
  },
});

export const invalidate = internalMutation({
  args: { memoryId: v.id("recoveryMemories") },
  handler: async (ctx, { memoryId }) => {
    requireDev();
    await ctx.db.patch(memoryId, { invalidatedAt: Date.now() });
  },
});

export const failSource = internalMutation({
  args: { memoryId: v.id("recoveryMemories") },
  handler: async (ctx, { memoryId }) => {
    requireDev();
    const memory = (await ctx.db.get(memoryId))!;
    const verification = (await ctx.db.get(memory.verificationId))!;
    const { _id, _creationTime, ...fields } = verification;
    await ctx.db.insert("verifications", {
      ...fields,
      verdict: "failed",
      completedAt: verification.completedAt + 1,
      summary: "Staged later failure of the source action.",
    });
  },
});

export const prove = action({
  args: {},
  handler: async (ctx): Promise<unknown> => {
    requireDev();
    if (process.env.SUPERMEMORY_API_KEY)
      throw new Error(
        "Run this no-key proof only on a local deployment without SUPERMEMORY_API_KEY.",
      );
    const first = await ctx.runMutation(internal.memory.dev.seed, {
      outcome: "verified",
    });
    const learned = await ctx.runAction(internal.memory.service.learn, {
      caseId: first.caseId,
    });
    if (
      !learned.saved ||
      !learned.memoryId ||
      learned.timesVerified !== 1 ||
      learned.supermemoryWritten ||
      !learned.summary.includes("not configured")
    )
      throw new Error("First verified case or no-key fallback failed.");
    const repeated = await ctx.runAction(internal.memory.service.learn, {
      caseId: first.caseId,
    });
    if (repeated.memoryId !== learned.memoryId || repeated.timesVerified !== 1)
      throw new Error("Repeated verification counted twice.");
    const second = await ctx.runMutation(internal.memory.dev.seed, {
      appId: first.appId,
      outcome: "verified",
    });
    const updated = await ctx.runAction(internal.memory.service.learn, {
      caseId: second.caseId,
    });
    if (
      updated.memoryId !== learned.memoryId ||
      updated.timesApplied !== 2 ||
      updated.timesVerified !== 2
    )
      throw new Error("Distinct verified outcome was not aggregated.");
    const notSaved: Record<string, string> = {};
    for (const outcome of [
      "unverified",
      "declined",
      "unresolved",
      "wrong_revision",
      "uncovered",
      "latest_failed",
    ] as const) {
      const fixture = await ctx.runMutation(internal.memory.dev.seed, {
        appId: first.appId,
        outcome,
      });
      const result = await ctx.runAction(internal.memory.service.learn, {
        caseId: fixture.caseId,
      });
      if (result.saved)
        throw new Error(`${outcome} unexpectedly wrote a recovery memory.`);
      notSaved[outcome] = result.summary;
    }
    const recounted = await ctx.runAction(internal.memory.service.learn, {
      caseId: second.caseId,
    });
    if (recounted.timesApplied !== 7 || recounted.timesVerified !== 2)
      throw new Error(
        "Completed applications and verified outcomes were conflated.",
      );
    const matching = await ctx.runAction(internal.memory.service.recall, {
      appId: first.appId,
      signature: first.signature,
      facts,
    });
    if (matching.candidates.length !== 1 || !matching.candidates[0].applies)
      throw new Error("Matching facts did not apply.");
    const counterexample = await ctx.runAction(internal.memory.service.recall, {
      appId: first.appId,
      signature: first.signature,
      facts: { ...facts, "journey.failedStep": "submit_booking" },
    });
    if (
      counterexample.candidates[0].applies ||
      !counterexample.candidates[0].failedChecks.some((check) =>
        check.includes("journey.failedStep"),
      )
    )
      throw new Error("Counterexample did not name the failed check.");
    const missingFacts: Record<string, string | boolean> = { ...facts };
    delete missingFacts["journey.failedStep"];
    const missing = await ctx.runAction(internal.memory.service.recall, {
      appId: first.appId,
      signature: first.signature,
      facts: missingFacts,
    });
    if (
      missing.candidates[0].applies ||
      !missing.candidates[0].failedChecks.some((check) =>
        check.includes("not observed"),
      )
    )
      throw new Error("Missing fact did not fail closed.");
    const orphan = await ctx.runQuery(internal.memory.records.candidates, {
      appId: first.appId,
      signature: "unmatched",
      texts: [
        "A similar story without a Convex record",
        "Convex recovery memory: orphan",
      ],
    });
    if (orphan.length)
      throw new Error("An orphaned search hit became a candidate.");
    const linked = await ctx.runQuery(internal.memory.records.candidates, {
      appId: first.appId,
      signature: "unmatched",
      texts: [`Convex recovery memory: ${learned.memoryId}`],
    });
    if (linked.length !== 1 || linked[0]._id !== learned.memoryId)
      throw new Error(
        "A backed search result did not resolve to its Convex record.",
      );
    const other = await ctx.runMutation(internal.memory.dev.seed, {
      outcome: "verified",
    });
    const otherMemory = await ctx.runAction(internal.memory.service.learn, {
      caseId: other.caseId,
    });
    if (!otherMemory.memoryId)
      throw new Error("Source-evidence fixture did not learn.");
    const foreign = await ctx.runQuery(internal.memory.records.candidates, {
      appId: other.appId,
      signature: "unmatched",
      texts: [`Convex recovery memory: ${learned.memoryId}`],
    });
    if (foreign.length)
      throw new Error("A search result crossed app ownership.");
    await ctx.runMutation(internal.memory.dev.failSource, {
      memoryId: otherMemory.memoryId,
    });
    const disqualified = await ctx.runAction(internal.memory.service.recall, {
      appId: other.appId,
      signature: other.signature,
      facts,
    });
    if (
      disqualified.candidates[0].applies ||
      !disqualified.candidates[0].failedChecks.some((check) =>
        check.includes("source action"),
      )
    )
      throw new Error("A later failed source verification still applied.");
    const wrongType = evaluateCheck(
      { field: "flags.recommendationsEnabled", operator: "eq", value: true },
      { "flags.recommendationsEnabled": "true" },
    );
    const unknown = evaluateCheck(
      { field: "configuration.providerTimeout", operator: "neq", value: false },
      { "configuration.providerTimeout": true },
    );
    const notWhenMissing = applicability(
      {
        ...matching.candidates[0],
        conditionChecks: [],
        notWhenChecks: [{ field: "health.ok", operator: "eq", value: false }],
      },
      {},
    );
    if (
      !wrongType.unknown ||
      !unknown.unknown ||
      notWhenMissing.applies ||
      !notWhenMissing.failedChecks.some((check) =>
        check.includes("not observed"),
      )
    )
      throw new Error("Invalid or not-when facts did not fail closed.");
    await ctx.runMutation(internal.memory.dev.invalidate, {
      memoryId: learned.memoryId,
    });
    const invalidated = await ctx.runAction(internal.memory.service.recall, {
      appId: first.appId,
      signature: first.signature,
      facts,
    });
    if (
      invalidated.candidates[0].applies ||
      !invalidated.candidates[0].failedChecks.includes(
        "This recovery memory has been invalidated.",
      )
    )
      throw new Error("Invalidated memory applied.");
    const input = await ctx.runQuery(internal.runner.run.loadInput, {
      attemptId: await ctx.runMutation(internal.memory.dev.learnInput, {
        caseId: second.caseId,
      }),
    });
    if (!input) throw new Error("Learn handler input could not be loaded.");
    const handlerResult = await learnHandler.run(ctx, {
      ...input,
      idempotencyKey: input.step._id,
      approval: null,
    });
    if (
      handlerResult.status !== "done" ||
      !handlerResult.summary.includes("recovery memory")
    )
      throw new Error("Learn handler did not report its saved record.");
    return {
      staged: true,
      memoryId: learned.memoryId,
      first: learned,
      repeated,
      second: updated,
      recounted,
      notSaved,
      matching: matching.candidates.map((row) => ({
        applies: row.applies,
        failedChecks: row.failedChecks,
      })),
      counterexample: counterexample.candidates[0].failedChecks,
      missing: missing.candidates[0].failedChecks,
      invalidated: invalidated.candidates[0].failedChecks,
      orphanIgnored: true,
      backedHitResolved: true,
      foreignAppIgnored: true,
      disqualifiedSource: disqualified.candidates[0].failedChecks,
      invalidFactsFailClosed: true,
      handler: handlerResult.summary,
    };
  },
});

export const learnInput = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) => {
    requireDev();
    const step = (await loadSteps(ctx, caseId)).find(
      (row) => row.purpose === "learn",
    )!;
    return await startAttempt(ctx, step._id);
  },
});
