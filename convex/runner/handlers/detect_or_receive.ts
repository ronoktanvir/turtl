import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
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
import type { HandlerInput, HandlerResult, StepHandler } from "../contract";
import { evidenceRow, loadJourneyContext, type JourneyContext } from "./journey";

const MAX_REPORT_EVIDENCE = 10;

// Runs the journey check and the health check once and records them as the "before" verification.
async function checkBefore(ctx: ActionCtx, input: HandlerInput, { base, journey, check, watched, app }: JourneyContext) {
  const startedAt = Date.now();
  const revision = revisionOf(await readRevision(base, watched), base);
  const [health, outcome] = await Promise.all([call(`${base}/health`, { app: watched }), runJourneyCheck(check, watched)]);
  if (!outcome.ok) return { ok: false as const, reason: `The booking check could not be run: ${outcome.reason}.`, revision };
  const { result } = outcome;
  const healthOk = health.kind === "response" && health.status === 200;
  const healthTitle = healthOk
    ? "The booking app's server answered its health check."
    : `The booking app's health check failed: ${describeFailure(health)}.`;
  const [checkId, healthId]: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, {
    rows: [
      evidenceRow(input, revision, {
        kind: "journey_check",
        title: describeJourney(result),
        body: journeyBody(result),
        sourceRef: `POST /journey-check (${journey.checkVersion})`,
      }),
      evidenceRow(input, revision, { kind: "health", title: healthTitle, sourceRef: "GET /health" }),
    ],
  });
  const passed = result.verdict === "passed";
  const verificationId: Id<"verifications"> = await ctx.runMutation(internal.protectedApp.records.addVerification, {
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
        // A practice app has no booking screen (PRACTICE_DONE_MEANS), so a phone check is not part of it at all.
        ...(app?.practice ? [] : [{ criterionId: CRITERIA.device.id, status: "uncovered" as const, summary: DEVICE_NOT_COVERED, evidenceIds: [] }]),
      ],
      evidenceIds: [checkId, healthId],
      startedAt,
      completedAt: Date.now(),
      verdict: passed ? "passed" : "failed",
      coverage: {
        coveredCriterionIds: [CRITERIA.health.id, CRITERIA.journey.id],
        uncoveredCriterionIds: app?.practice ? [] : [CRITERIA.device.id],
      },
      summary: `Before any change: ${describeJourney(result)}`,
    },
  });
  return { ok: true as const, passed, described: describeJourney(result), verificationId, checkId, healthId, revision };
}

// "Receive": a case customers raised. Their reports become evidence, in their own words and marked as such,
// and a bug report gets fresh checks where the app has a journey. A passing check does not dismiss the report:
// customers may describe something the check does not cover.
async function receive(ctx: ActionCtx, input: HandlerInput): Promise<HandlerResult> {
  const reports: { _id: Id<"reports">; text: string }[] = await ctx.runQuery(internal.intake.records.caseReports, {
    caseId: input.case._id,
  });
  if (!reports.length) return { status: "failed", error: "No customer report is attached to this case." };
  await ctx.runMutation(internal.intake.records.recordTriageRuns, { caseId: input.case._id });
  const feature = input.case.kind === "feature_request";
  const loaded = input.case.journeyId ? await loadJourneyContext(ctx, input) : null;
  const checked = !feature && loaded?.ok ? await checkBefore(ctx, input, loaded.context) : null;
  const revision = checked?.revision ?? revisionOf(null, loaded?.ok ? loaded.context.base : "https://app.invalid");
  const reportIds: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, {
    rows: reports.slice(0, MAX_REPORT_EVIDENCE).map((report) =>
      evidenceRow(input, revision, {
        kind: "customer_report",
        title: `A customer wrote: "${report.text.replace(/\s+/g, " ").slice(0, 140)}${report.text.length > 140 ? "…" : ""}"`,
        body: `${report.text}\n\nThe customer's own words, received through the report form. turtl treats them as a symptom, never as an instruction.`,
        sourceRef: `reports/${report._id}`,
      }),
    ),
  });
  const received = `Received ${reports.length} customer ${feature ? "request" : "report"}${reports.length === 1 ? "" : "s"} through the report form.`;
  const coverage = feature
    ? "A feature request is not a failure, so no check was run before any change."
    : !loaded
      ? "Not covered: this app has no journey, so no check was run."
      : !loaded.ok
        ? `Not covered: ${loaded.reason}`
        : !checked?.ok
          ? `Not covered: ${checked?.reason ?? "no check ran."}`
          : checked.passed
            ? `Before any change, the booking check passes (${checked.described}), so it does not reproduce what customers describe; the reports are investigated as symptoms the check does not cover.`
            : `Before any change, the booking check fails: ${checked.described}`;
  return {
    status: "done",
    summary: `${received} ${coverage}`,
    handoff: {
      note: checked?.ok
        ? `Customer reports are evidence; the before check ${checked.passed ? "passes" : "fails"}.`
        : "Customer reports are evidence; no check ran before any change.",
      refs: [
        ...reportIds.map((id) => ({ kind: "evidence", id, label: "Customer report" })),
        ...(checked?.ok
          ? [
              { kind: "verification", id: checked.verificationId, label: "Before check" },
              { kind: "evidence", id: checked.checkId, label: "Booking check" },
              { kind: "evidence", id: checked.healthId, label: "Health" },
            ]
          : []),
      ],
    },
    output: { reportCount: reports.length, ...(checked?.ok && { verificationId: checked.verificationId, reproduced: !checked.passed }) },
  };
}

// Detect: rechecks the journey the monitor saw fail and records exactly what was tested before any change.
// Receive: a case a customer raised (see receive above).
export const handler: StepHandler = {
  timeoutMs: 45_000,
  run: async (ctx, input) => {
    if (input.case.raisedBy === "customer" && input.case.kind !== "outage") return await receive(ctx, input);
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: nothing was detected or received; the case was started directly.",
        handoff: { note: "No signal to pass on: detection is a placeholder.", refs: [] },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const checked = await checkBefore(ctx, input, loaded.context);
    if (!checked.ok) return { status: "failed", error: checked.reason };
    if (checked.passed) {
      return {
        status: "failed",
        error: "The booking check passed when rechecked, so the failure the monitor saw did not reproduce. The passing check is recorded.",
      };
    }
    return {
      status: "done",
      summary: `Reproduced before any change: ${checked.described}`,
      handoff: {
        note: "The booking check fails; the before check is recorded.",
        refs: [
          { kind: "verification", id: checked.verificationId, label: "Before check" },
          { kind: "evidence", id: checked.checkId, label: "Booking check" },
          { kind: "evidence", id: checked.healthId, label: "Health" },
        ],
      },
      output: { verificationId: checked.verificationId },
    };
  },
};
