import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { CRITERIA, DONE_MEANS, ENVIRONMENT } from "../../protectedApp/client";
import type { ProposalOption } from "../../constants";
import { gateFor } from "../../consent/gate";
import { fixesModelId, planFixes } from "../../fixOptions";
import type { ContextUse } from "../../learning/context";
import { applicablePreferences } from "../../learning/preferences";
import { conditionsOf } from "../../learning/rules";
import type { StepHandler } from "../contract";
import { factsOf, loadJourneyContext } from "./journey";

type Diagnosis = {
  source: "model" | "rules";
  cause: string;
  confidence: number;
  supportingEvidenceIds: Id<"evidence">[];
};

// Writes proposal version 1: the catalog option, plus up to three code changes a model proposes (fixOptions.ts).
export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input) => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary:
          "Placeholder: no plan was made, so there is no specific action to approve.",
        handoff: {
          note: "No plan to pass on: planning is a placeholder.",
          refs: [],
        },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { catalog, journey, steps, evidence } = loaded.context;
    const facts = factsOf(loaded.context);
    const investigation = steps.find((s) => s.purpose === "investigate")
      ?.currentAttempt?.output as
      | { diagnosis?: Diagnosis; evidenceId?: Id<"evidence"> }
      | undefined;
    const diagnosis = investigation?.diagnosis;
    if (!facts)
      return {
        status: "failed",
        error: "There are no fresh facts to plan from.",
      };
    const remembered = loaded.context.case.matchedMemoryId
      ? await ctx.runQuery(internal.memory.records.remembered, {
          caseId: input.case._id,
          facts,
        })
      : null;
    if (loaded.context.case.matchedMemoryId && !remembered)
      return {
        status: "failed",
        error:
          "The matched recovery memory no longer passes its conditions or source-proof checks, so no remembered action is offered.",
      };
    if (!remembered && !diagnosis)
      return {
        status: "failed",
        error:
          "There is no diagnosis or applicable recovery memory to plan from.",
      };

    const entry = catalog.find(
      (e) =>
        e.type === "set_feature_flag" &&
        (!remembered ||
          e._id === remembered.action.executionPayload.actionCatalogId) &&
        e.parameterConstraints.some(
          (c) =>
            c.name === "flag" &&
            c.allowedValues?.includes("recommendationsEnabled"),
        ),
    );
    if (!entry || entry.config.kind !== "http") {
      return {
        status: "failed",
        error:
          "This app's action catalog has no action that fits, so nothing can be proposed.",
      };
    }

    const recommended =
      !!remembered ||
      (facts["journey.verdict"] === "failed" &&
        facts["journey.failedStep"] === "recommendations" &&
        facts["journey.errorCode"] === "RECOMMENDATIONS_TIMEOUT" &&
        facts["flags.recommendationsEnabled"] === true);
    const history = remembered
      ? `This recovery worked before and was checked ${remembered.memory.timesVerified} time${remembered.memory.timesVerified === 1 ? "" : "s"}. Its conditions were rechecked against this case's fresh observations, and the service is checked again after the change.`
      : "";
    const failed = facts["errors.failedBookings"];
    const total = facts["errors.totalBookings"];
    const usersCantNow =
      typeof failed === "number" && typeof total === "number" && failed > 0
        ? `Customers can't finish a booking: ${failed} of ${total} booking attempts in the last 15 minutes failed.`
        : `Customers can't finish a booking: the booking check fails at the "${facts["journey.failedStep"] ?? "unknown"}" step. No customer booking has failed in the last 15 minutes yet.`;
    const checkEvidence = evidence
      .filter(
        (e) =>
          e.stepAttemptId ===
          steps.find((s) => s.purpose === "gather_context")?.currentAttemptId,
      )
      .filter(
        (e) =>
          e.kind === "journey_check" ||
          e.kind === "flags" ||
          e.kind === "errors",
      )
      .map((e) => e._id);
    const evidenceIds = [
      ...new Set([
        ...(investigation?.evidenceId ? [investigation.evidenceId] : []),
        ...(diagnosis?.supportingEvidenceIds ?? []),
        ...evidence
          .filter(
            (row) =>
              remembered &&
              row.kind === "memory_match" &&
              row.sourceRef === `recoveryMemories/${remembered.memory._id}`,
          )
          .map((row) => row._id),
        ...checkEvidence,
      ]),
    ];

    const catalogOption: ProposalOption = {
            key: "turn_off_recommendations",
            title: remembered
              ? `Use the recovery that worked before: ${entry.name}`
              : entry.name,
            kind: "recovery",
            actionType: entry.type,
            actionCatalogId: entry._id,
            target: {
              environment: ENVIRONMENT,
              resourceRef: `${entry.config.url}#recommendationsEnabled`,
            },
            parameters: remembered
              ? remembered.action.executionPayload.parameters
              : [
                  { name: "flag", value: "recommendationsEnabled" },
                  { name: "value", value: false },
                ],
            acceptanceCriteria: [CRITERIA.recommendationsOff, ...DONE_MEANS],
            checkRefs: [
              { journeyId: journey._id, version: journey.checkVersion },
            ],
            usersCantNow,
            whatChanges: `Turns off service suggestions in the booking app, so booking stops waiting for the recommendations provider.${history ? ` ${history}` : ""}`,
            whatMightBeLost:
              "Customers won't see suggested services until recommendations are turned back on. Bookings already made don't change, and the slow provider itself is not fixed.",
            howChecked:
              "turtl checks that the booking app answers, that recommendations read as off, and then runs the booking check: a test booking must be saved and match its confirmation. The booking screen on a real device is not checked yet.",
            evidenceIds,
            recommended,
            confidence: remembered
              ? remembered.option.confidence
              : diagnosis!.confidence,
    };
    const gathered = steps.find((s) => s.purpose === "gather_context")?.currentAttempt?.output as
      | { context?: { uses?: ContextUse[] } }
      | undefined;
    const context = gathered?.context?.uses ?? [];
    const conditions = conditionsOf(loaded.context.case.signature, facts);
    const [applied, feedback] = await Promise.all([
      applicablePreferences(ctx, input.case.appId, `${input.case.title}. ${input.case.impact} ${diagnosis?.cause ?? ""}`),
      ctx.runQuery(internal.learning.feedback.history, {
        appId: input.case.appId,
        caseId: input.case._id,
        conditionsKey: conditions.key,
      }),
    ]);
    const started = Date.now();
    const agentRunId: Id<"agentRuns"> | null = await ctx.runMutation(internal.learning.runs.start, {
      caseId: input.case._id,
      stepAttemptId: input.attempt._id,
      taskType: "propose_fixes",
      modelId: fixesModelId(),
      promptVersion: "plan-fixes-learning-v1",
      contextRefs: [...new Set(context.map((use) => use.contextSourceId))],
    });
    const planned = await planFixes({
      base: catalogOption,
      baseRecommended: recommended,
      remembered: !!remembered,
      catalog,
      basis: {
        journey,
        doneMeans: DONE_MEANS,
        evidenceIds,
        usersCantNow,
      },
      appName: loaded.context.app?.name ?? "the app",
      caseRow: loaded.context.case,
      facts,
      cause: diagnosis?.cause ?? null,
      evidence,
      preferences: applied.preferences,
      feedback: { turnedDown: feedback.turnedDown, conditionsText: conditions.text, recent: feedback.recent },
      context,
    }, gateFor(ctx, { appId: input.case.appId }));
    if (agentRunId) {
      await ctx.runMutation(internal.learning.runs.finish, {
        agentRunId,
        status: planned.modelAnswered ? "completed" : "failed",
        durationMs: Date.now() - started,
        ...(planned.noModelReason && { error: `No model answered: ${planned.noModelReason}. Only the catalog action was offered.` }),
      });
    }
    const learnedNote = [
      applied.summary,
      feedback.sameConditionsCount
        ? `Read ${feedback.sameConditionsCount} earlier decision${feedback.sameConditionsCount === 1 ? "" : "s"} of yours under the same conditions.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const proposalId: Id<"proposals"> = await ctx.runMutation(
      internal.protectedApp.records.writeProposal,
      {
        caseId: input.case._id,
        stepId: input.step._id,
        doneMeans: DONE_MEANS,
        options: planned.options,
      },
    );
    const pick = planned.options.find((o) => o.recommended);
    return {
      status: "done",
      summary: `${remembered
        ? `Offered recovery memory ${remembered.memory._id} directly. ${history}`
        : recommended
          ? "Proposed turning off recommendations to restore booking."
          : "Proposed turning off recommendations, but the facts don't point to recommendations."} ${pick ? `Recommended: "${pick.title}". Waiting for the owner's decision.` : "Nothing is recommended."} ${planned.note} ${learnedNote}`,
      handoff: {
        note: "Proposal version 1 is ready for the owner.",
        refs: [{ kind: "proposal", id: proposalId, label: "v1" }],
      },
      output: { proposalId, matchedMemoryId: remembered?.memory._id ?? null },
    };
  },
};
