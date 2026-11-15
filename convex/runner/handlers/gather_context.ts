import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  CREDENTIAL_REF,
  call,
  describeFailure,
  describeJourney,
  journeyBody,
  readErrors,
  readRevision,
  revisionOf,
  runJourneyCheck,
  topErrorCode,
} from "../../protectedApp/client";
import type { StepHandler } from "../contract";
import { evidenceRow, loadJourneyContext, type Facts } from "./journey";

// Reads the booking app fresh and hands on a flat set of facts (keys in handoffs/phase2-seams.md).
export const handler: StepHandler = {
  timeoutMs: 45_000,
  run: async (ctx, input) => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: no logs, deploys or history were gathered.",
        handoff: { note: "No context to pass on: gathering is a placeholder.", refs: [] },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { base, journey, check } = loaded.context;

    const [outcome, errors, flags, health, revisionText] = await Promise.all([
      runJourneyCheck(check),
      readErrors(base),
      call(`${base}/flags`, { credentialRef: CREDENTIAL_REF }),
      call(`${base}/health`),
      readRevision(base),
    ]);
    const revision = revisionOf(revisionText, base);
    const facts: Facts = {};
    const rows: ReturnType<typeof evidenceRow>[] = [];
    const missing: string[] = [];

    if (outcome.ok) {
      const { result } = outcome;
      facts["journey.verdict"] = result.verdict;
      facts["journey.failedStep"] = result.failedStep ?? "none";
      facts["journey.errorCode"] = result.error?.code ?? "none";
      rows.push(
        evidenceRow(input, revision, {
          kind: "journey_check",
          title: describeJourney(result),
          body: journeyBody(result),
          sourceRef: `POST /journey-check (${journey.checkVersion})`,
        }),
      );
    } else {
      missing.push(`the booking check (${outcome.reason})`);
    }

    const flagValue = (flags.kind === "response" && flags.status === 200
      ? (flags.body as { recommendationsEnabled?: unknown } | null)?.recommendationsEnabled
      : undefined);
    if (typeof flagValue === "boolean") {
      facts["flags.recommendationsEnabled"] = flagValue;
      rows.push(
        evidenceRow(input, revision, {
          kind: "flags",
          title: flagValue ? "Recommendations are turned on." : "Recommendations are turned off.",
          body: `recommendationsEnabled is ${flagValue}.`,
          sourceRef: "GET /flags",
        }),
      );
    } else {
      missing.push(`the recommendations flag (${describeFailure(flags)})`);
    }

    const healthOk =
      health.kind === "response" &&
      health.status === 200 &&
      (health.body as { ok?: unknown } | null)?.ok === true;
    facts["health.ok"] = healthOk;
    rows.push(
      evidenceRow(input, revision, {
        kind: "health",
        title: healthOk
          ? "The booking app's server answered its health check."
          : `The booking app's health check failed: ${describeFailure(health)}.`,
        body: "A passing health check only proves the server responds, not that booking works.",
        sourceRef: "GET /health",
      }),
    );

    if (errors.ok) {
      const { counts } = errors.body;
      const top = topErrorCode(errors.body);
      facts["errors.totalBookings"] = counts.totalBookings;
      facts["errors.failedBookings"] = counts.failedBookings;
      facts["errors.errorRate"] = counts.errorRate;
      facts["errors.topCode"] = top;
      rows.push(
        evidenceRow(input, revision, {
          kind: "errors",
          title: `${counts.failedBookings} of ${counts.totalBookings} customer booking attempts failed in the last 15 minutes.`,
          body: `Error rate ${Math.round(counts.errorRate * 100)}%. Most common error: ${top}.${errors.body.window.truncated ? " The sample was capped at 1,000 attempts." : ""}`,
          sourceRef: "GET /errors",
        }),
      );
    } else {
      missing.push(`failed bookings (${errors.reason})`);
    }

    if (revisionText) {
      facts["app.revision"] = revisionText;
      rows.push(
        evidenceRow(input, revision, {
          kind: "revision",
          title: `The booking app reports revision ${revisionText}.`,
          sourceRef: "GET /revision",
        }),
      );
    } else {
      missing.push("the app's revision");
    }

    const ids: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, { rows });
    if (!outcome.ok && !errors.ok && flagValue === undefined) {
      return { status: "failed", error: `Could not read the booking app: ${missing.join("; ")}.` };
    }
    const read = ["the booking check", "failed bookings", "the recommendations flag", "health", "revision"].length - missing.length;
    return {
      status: "done",
      summary: missing.length
        ? `Read ${read} of 5 sources from the booking app. Could not read ${missing.join("; ")}.`
        : "Read the booking check, failed bookings, the recommendations flag, health and revision from the booking app.",
      handoff: {
        note: "Facts from the booking app are in this attempt's output.",
        refs: ids.map((id, i) => ({ kind: "evidence", id, label: rows[i].kind })),
      },
      output: { facts },
    };
  },
};
