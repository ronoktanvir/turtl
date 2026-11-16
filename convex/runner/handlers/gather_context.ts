import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { describeJourney, journeyBody, runJourneyCheck } from "../../protectedApp/client";
import { readAppEvidence, type AppEvidence } from "../../evidence/context";
import { supplyContext } from "../../learning/context";
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
        handoff: {
          note: "No context to pass on: gathering is a placeholder.",
          refs: [],
        },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { journey, check, watched } = loaded.context;
    const [outcome, app] = await Promise.all([
      runJourneyCheck(check, watched),
      readAppEvidence(ctx, input, loaded.context),
    ]);
    const { revision } = app;
    const facts: Facts = {};
    const missing: string[] = [];
    let journeyRefs: AppEvidence["refs"] = [];
    let observed = "";
    if (outcome.ok) {
      const { result } = outcome;
      observed = journeyBody(result);
      facts["journey.verdict"] = result.verdict;
      facts["journey.failedStep"] = result.failedStep ?? "none";
      facts["journey.errorCode"] = result.error?.code ?? "none";
      const [id]: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, {
        rows: [
          evidenceRow(input, revision, {
            kind: "journey_check",
            title: describeJourney(result),
            body: journeyBody(result),
            sourceRef: `POST /journey-check (${journey.checkVersion})`,
          }),
        ],
      });
      journeyRefs = [{ kind: "evidence", id, label: "journey_check" }];
    } else {
      missing.push(`the booking check (${outcome.reason})`);
    }
    Object.assign(facts, app.facts);
    missing.push(...app.missing);
    const revisionText = typeof facts["app.revision"] === "string" ? facts["app.revision"] : null;
    if (!outcome.ok && !("errors.totalBookings" in facts) && !("flags.recommendationsEnabled" in facts)) {
      return {
        status: "failed",
        error: `Could not read the booking app: ${missing.join("; ")}.`,
      };
    }
    const read =
      [
        "the booking check",
        "failed bookings",
        "the recommendations flag",
        "health",
        "revision",
      ].length - missing.length;
    const recalled = await ctx.runAction(internal.memory.service.recall, {
      appId: input.case.appId,
      signature: input.case.signature ?? `journey_failed:${journey._id}`,
      facts,
      symptoms: `${input.case.title}. ${input.case.impact}`,
    });
    const memoryEvidence: Id<"evidence">[] = recalled.candidates.length
      ? await ctx.runMutation(internal.protectedApp.records.addEvidence, {
          rows: recalled.candidates.map((memory) =>
            evidenceRow(input, revision, {
              kind: "memory_match",
              title: memory.applies
                ? `Recovery memory ${memory._id} applies: its conditions were rechecked now.`
                : `Recovery memory ${memory._id} does not apply.`,
              body: memory.applies
                ? `Previously verified ${memory.timesVerified} time(s). ${memory.conditions.join("; ")}. Owner approval and verification are still required.`
                : memory.failedChecks.join("\n"),
              sourceRef: `recoveryMemories/${memory._id}`,
            }),
          ),
        })
      : [];
    const applicable = recalled.candidates
      .filter((memory) => memory.applies)
      .sort(
        (a, b) =>
          b.timesVerified - a.timesVerified ||
          b._creationTime - a._creationTime,
      )[0];
    const matched = !!applicable;
    const recallNote = matched
      ? ` Recovery memory ${applicable!._id} applies; investigation was skipped after current checks passed.`
      : recalled.candidates.length
        ? " No remembered recovery applies, so investigation will run in full."
        : " No recovery memory was found.";
    const context = await supplyContext(ctx, {
      caseRow: input.case,
      stepAttemptId: input.attempt._id,
      facts,
      observed,
      revision: revisionText,
      memories: recalled.candidates,
    }).catch((error: unknown) => ({
      uses: [],
      summary: `No context sources were recorded: ${error instanceof Error ? error.message : "recording failed"}.`,
    }));
    return {
      status: "done",
      summary: missing.length
        ? `Read ${read} of 5 sources from the booking app. Could not read ${missing.join("; ")}.${recallNote} ${context.summary}`
        : `Read the booking check, failed bookings, the recommendations flag, health and revision from the booking app.${recallNote} ${context.summary}`,
      handoff: {
        note: "Facts from the booking app are in this attempt's output.",
        refs: [
          ...journeyRefs,
          ...app.refs,
          ...memoryEvidence.map((id) => ({
            kind: "evidence",
            id,
            label: "memory applicability",
          })),
        ],
      },
      output: {
        facts,
        recall: {
          candidates: recalled.candidates.map((memory) => ({
            memoryId: memory._id,
            applies: memory.applies,
            failedChecks: memory.failedChecks,
          })),
          matchedMemoryId: matched ? applicable!._id : null,
          summary: recalled.summary,
        },
        context: { uses: context.uses, summary: context.summary },
      },
    };
  },
};
