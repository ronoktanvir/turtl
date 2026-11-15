import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  CRITERIA,
  CRITERIA_VERSION,
  DEVICE_NOT_COVERED,
  ENVIRONMENT,
  call,
  describeFailure,
  describeJourney,
  journeyBody,
  readRevision,
  revisionOf,
  runJourneyCheck,
} from "../../protectedApp/client";
import type { StepHandler } from "../contract";
import { evidenceRow, loadJourneyContext } from "./journey";

// Rechecks the journey the monitor saw fail and records exactly what was tested before any change.
export const handler: StepHandler = {
  timeoutMs: 45_000,
  run: async (ctx, input) => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: nothing was detected or received; the case was started directly.",
        handoff: { note: "No signal to pass on: detection is a placeholder.", refs: [] },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { base, journey, check } = loaded.context;

    const startedAt = Date.now();
    const revision = revisionOf(await readRevision(base), base);
    const [health, outcome] = await Promise.all([call(`${base}/health`), runJourneyCheck(check)]);
    if (!outcome.ok) {
      return { status: "failed", error: `The booking check could not be run: ${outcome.reason}.` };
    }
    const { result } = outcome;
    const healthOk = health.kind === "response" && health.status === 200;
    const healthTitle = healthOk
      ? "The booking app's server answered its health check."
      : `The booking app's health check failed: ${describeFailure(health)}.`;
    const [checkId, healthId]: Id<"evidence">[] = await ctx.runMutation(
      internal.protectedApp.records.addEvidence,
      {
        rows: [
          evidenceRow(input, revision, {
            kind: "journey_check",
            title: describeJourney(result),
            body: journeyBody(result),
            sourceRef: `POST /journey-check (${journey.checkVersion})`,
          }),
          evidenceRow(input, revision, { kind: "health", title: healthTitle, sourceRef: "GET /health" }),
        ],
      },
    );
    const passed = result.verdict === "passed";
    const verificationId: Id<"verifications"> = await ctx.runMutation(
      internal.protectedApp.records.addVerification,
      {
        row: {
          caseId: input.case._id,
          journeyId: journey._id,
          stepAttemptId: input.attempt._id,
          phase: "before",
          environment: ENVIRONMENT,
          revision,
          checkVersion: journey.checkVersion,
          criteriaVersion: CRITERIA_VERSION,
          criterionResults: [
            { criterionId: CRITERIA.health.id, status: healthOk ? "passed" : "failed", summary: healthTitle, evidenceIds: [healthId] },
            { criterionId: CRITERIA.journey.id, status: passed ? "passed" : "failed", summary: describeJourney(result), evidenceIds: [checkId] },
            { criterionId: CRITERIA.device.id, status: "uncovered", summary: DEVICE_NOT_COVERED, evidenceIds: [] },
          ],
          evidenceIds: [checkId, healthId],
          startedAt,
          completedAt: Date.now(),
          verdict: passed ? "passed" : "failed",
          coverage: {
            coveredCriterionIds: [CRITERIA.health.id, CRITERIA.journey.id],
            uncoveredCriterionIds: [CRITERIA.device.id],
          },
          summary: `Before any change: ${describeJourney(result)}`,
        },
      },
    );
    if (passed) {
      return {
        status: "failed",
        error: "The booking check passed when rechecked, so the failure the monitor saw did not reproduce. The passing check is recorded.",
      };
    }
    return {
      status: "done",
      summary: `Reproduced before any change: ${describeJourney(result)}`,
      handoff: {
        note: "The booking check fails; the before check is recorded.",
        refs: [
          { kind: "verification", id: verificationId, label: "Before check" },
          { kind: "evidence", id: checkId, label: "Booking check" },
          { kind: "evidence", id: healthId, label: "Health" },
        ],
      },
      output: { verificationId },
    };
  },
};
