import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { CRITERIA, DONE_MEANS, ENVIRONMENT } from "../../protectedApp/client";
import type { StepHandler } from "../contract";
import { factsOf, loadJourneyContext } from "./journey";

type Diagnosis = {
  source: "model" | "rules";
  cause: string;
  confidence: number;
  supportingEvidenceIds: Id<"evidence">[];
};

// Writes proposal version 1. Its options come only from the app's action catalog.
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
      ? `This recovery worked before: ${remembered.memory.timesVerified} verified recovery outcome(s), last verified ${new Date(remembered.verification.completedAt).toISOString()}. Its conditions were rechecked against this case's fresh observations. A new verification is still required, and the owner is asked first unless their permission covers this exact action.`
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

    const proposalId: Id<"proposals"> = await ctx.runMutation(
      internal.protectedApp.records.writeProposal,
      {
        caseId: input.case._id,
        stepId: input.step._id,
        doneMeans: DONE_MEANS,
        options: [
          {
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
          },
        ],
      },
    );
    return {
      status: "done",
      summary: remembered
        ? `Offered recovery memory ${remembered.memory._id} directly. ${history}`
        : recommended
          ? "Proposed turning off recommendations to restore booking. Waiting for the owner's decision."
          : "Proposed turning off recommendations, but the facts don't point to recommendations, so it is not recommended.",
      handoff: {
        note: "Proposal version 1 is ready for the owner.",
        refs: [{ kind: "proposal", id: proposalId, label: "v1" }],
      },
      output: { proposalId, matchedMemoryId: remembered?.memory._id ?? null },
    };
  },
};
