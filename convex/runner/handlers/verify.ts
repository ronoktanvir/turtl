import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { CriterionResult } from "../../constants";
import {
  CRITERIA,
  CRITERIA_VERSION,
  ENVIRONMENT,
  call,
  describeFailure,
  describeJourney,
  journeyBody,
  readRevision,
  revisionOf,
  runJourneyCheck,
} from "../../protectedApp/client";
import { checkBookingScreen } from "../../revyl/device";
import type { HandlerResult, StepHandler } from "../contract";
import { evidenceRow, loadJourneyContext } from "./journey";

// Health first, then the flag, then the booking check. A failing booking check fails the step,
// so the case can never end restored while booking is still broken.
export const handler: StepHandler = {
  timeoutMs: 9 * 60_000,
  run: async (ctx, input): Promise<HandlerResult> => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: no check ran, so nothing was verified.",
        handoff: { note: "No verification result: verification is a placeholder.", refs: [] },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { base, journey, check } = loaded.context;
    const action: Doc<"actions"> | null = loaded.context.action;
    if (!action || action.status !== "completed") {
      return { status: "failed", error: "No completed action to verify." };
    }
    const payload = action.executionPayload;
    const codeChange = payload.config.kind === "capy";
    const startedAt = Date.now();
    const deployedRevision = await readRevision(base);
    const revision = revisionOf(deployedRevision, base);
    if (codeChange) {
      const pullRequest = await ctx.runQuery(internal.prTracking.records.forAction, { actionId: action._id });
      if (!pullRequest?.mergeCommitSha || pullRequest.snapshot?.state !== "merged" || deployedRevision !== pullRequest.mergeCommitSha) {
        return { status: "failed", error: "The approved code change is not confirmed deployed at its merged revision; no booking or device check ran." };
      }
    }
    const rows: ReturnType<typeof evidenceRow>[] = [];
    const results = new Map<string, Omit<CriterionResult, "criterionId" | "evidenceIds"> & { evidence?: number }>();

    const health = await call(`${base}/health`);
    const healthOk = health.kind === "response" && health.status === 200;
    rows.push(
      evidenceRow(input, revision, {
        kind: "health",
        title: healthOk ? "The booking app's server answered its health check." : `The health check failed: ${describeFailure(health)}.`,
        sourceRef: "GET /health",
      }),
    );
    results.set(CRITERIA.health.id, { status: healthOk ? "passed" : "failed", summary: rows[0].title, evidence: 0 });

    let journeyPassed = false;
    if (healthOk) {
      if (!codeChange) {
        const flags = await call(payload.config.kind === "http" ? payload.config.url : `${base}/flags`, {
          credentialRef: payload.config.credentialRef,
        });
        const flagValue =
          flags.kind === "response" && flags.status === 200
            ? (flags.body as { recommendationsEnabled?: unknown } | null)?.recommendationsEnabled
            : undefined;
        const flagTitle =
          typeof flagValue === "boolean"
            ? `Recommendations read as ${flagValue ? "on" : "off"}.`
            : `The recommendations flag could not be read: ${describeFailure(flags)}.`;
        rows.push(evidenceRow(input, revision, { kind: "flags", title: flagTitle, sourceRef: "GET /flags" }));
        results.set(CRITERIA.recommendationsOff.id, {
          status: flagValue === false ? "passed" : "failed",
          summary: flagTitle,
          evidence: rows.length - 1,
        });
      }

      const ref = payload.checkRefs.find((r) => r.journeyId === journey._id);
      const observedAt = Date.now();
      const outcome = await runJourneyCheck(check);
      const title = outcome.ok ? describeJourney(outcome.result) : `The booking check could not be run: ${outcome.reason}.`;
      rows.push(
        evidenceRow(input, revision, {
          kind: "journey_check",
          title,
          ...(outcome.ok && { body: journeyBody(outcome.result) }),
          sourceRef: `POST /journey-check (${journey.checkVersion}${ref && ref.version !== journey.checkVersion ? `; approved against ${ref.version}` : ""})`,
        }),
      );
      journeyPassed = outcome.ok && outcome.result.verdict === "passed";
      if (journeyPassed) await ctx.runMutation(internal.monitor.recordPass, { journeyId: journey._id, observedAt });
      results.set(CRITERIA.journey.id, { status: journeyPassed ? "passed" : "failed", summary: title, evidence: rows.length - 1 });

      if (journeyPassed && payload.acceptanceCriteria.some((criterion) => criterion.id === CRITERIA.device.id)) {
        const device = await checkBookingScreen(ctx, { caseId: input.case._id, stepAttemptId: input.attempt._id });
        if (device.evidence) rows.push(evidenceRow(input, revision, device.evidence));
        results.set(CRITERIA.device.id, { status: device.status, summary: device.summary, evidence: device.evidence && rows.length - 1 });
      }
    }

    const ids: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, { rows });
    const criterionResults: CriterionResult[] = payload.acceptanceCriteria.map((criterion) => {
      if (criterion.id === CRITERIA.device.id && healthOk && !results.has(criterion.id)) {
        const summary = "Not run: the server booking check did not pass, so the booking screen was not run on a device.";
        return { criterionId: criterion.id, status: "uncovered", summary, evidenceIds: [] };
      }
      const result = results.get(criterion.id);
      if (!result) {
        return {
          criterionId: criterion.id,
          status: "uncovered",
          summary: healthOk ? "Not covered: no check for this criterion ran." : "Not run: the health check failed first.",
          evidenceIds: [],
        };
      }
      return {
        criterionId: criterion.id,
        status: result.status,
        summary: result.summary,
        evidenceIds: result.evidence === undefined ? [] : [ids[result.evidence]],
      };
    });
    const covered = criterionResults.filter((r) => r.status !== "uncovered");
    const passed = covered.length > 0 && covered.every((r) => r.status === "passed") && journeyPassed;
    const uncovered = criterionResults.filter((r) => r.status === "uncovered").map((r) => r.criterionId);
    const deviceSummary = results.get(CRITERIA.device.id)?.summary ?? "Not checked: the booking screen on a device.";
    const summary = passed
      ? codeChange
        ? `The deployed code change at ${deployedRevision} passed the server health and booking checks. ${deviceSummary} These checks do not establish that every defect is repaired.`
        : `Service restored: the server answers, recommendations are off, and the booking check saved a booking. ${deviceSummary} The defect that let recommendations block booking is still in the code.`
      : `Not restored: ${covered.filter((r) => r.status === "failed").map((r) => r.summary).join(" ")}`;

    const verificationId: Id<"verifications"> = await ctx.runMutation(
      internal.protectedApp.records.addVerification,
      {
        row: {
          caseId: input.case._id,
          journeyId: journey._id,
          actionId: action._id,
          stepAttemptId: input.attempt._id,
          phase: codeChange ? "after_deploy" : "after_fix",
          environment: codeChange ? ENVIRONMENT : action.environment,
          revision,
          checkVersion: journey.checkVersion,
          criteriaVersion: CRITERIA_VERSION,
          criterionResults,
          evidenceIds: ids,
          startedAt,
          completedAt: Date.now(),
          verdict: passed ? "passed" : "failed",
          coverage: {
            coveredCriterionIds: covered.map((r) => r.criterionId),
            uncoveredCriterionIds: uncovered,
          },
          summary,
        },
      },
    );
    if (!passed) return { status: "failed", error: summary };
    return {
      status: "done",
      summary,
      ...(!codeChange && { caseStatus: "restored" as const }),
      handoff: {
        note: codeChange ? summary : "Service is restored, not repaired: recommendations are off and the coupling is still in the code.",
        refs: [
          { kind: "verification", id: verificationId, label: "After the fix" },
          ...ids.map((id) => ({ kind: "evidence", id })),
        ],
      },
      output: { verificationId },
    };
  },
};
