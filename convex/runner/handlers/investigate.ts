import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  askModel,
  modelId,
  ruleReading,
  type EvidenceSummary,
} from "../../diagnosis";
import { revisionOf } from "../../protectedApp/client";
import type { StepHandler } from "../contract";
import { evidenceRow, loadJourneyContext, type Facts } from "./journey";

// One model call over the facts and evidence from gather_context; a labelled rule-based reading when no model answers.
export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input) => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: no investigation ran.",
        handoff: {
          note: "No findings to pass on: investigation is a placeholder.",
          refs: [],
        },
      };
    }
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { base, evidence } = loaded.context;
    const source = input.parents.find(
      (p) => p.step.purpose === "gather_context",
    )?.attempt;
    const facts = source?.output?.facts as Facts | undefined;
    if (!source || !facts)
      return {
        status: "failed",
        error: "gather_context handed over no facts.",
      };
    const gathered: EvidenceSummary[] = evidence
      .filter((e) => e.stepAttemptId === source._id)
      .map((e) => ({
        id: e._id,
        kind: e.kind,
        title: e.title,
        ...(e.body && { body: e.body }),
      }));

    const model = modelId();
    const started = Date.now();
    const agentRunId: Id<"agentRuns"> = await ctx.runMutation(
      internal.diagnosis.startRun,
      {
        caseId: input.case._id,
        stepId: input.step._id,
        stepAttemptId: input.attempt._id,
        modelId: model,
      },
    );
    const answer = await askModel(facts, gathered);
    const noModel = answer.ok ? null : `No model answered: ${answer.reason}.`;
    await ctx.runMutation(internal.diagnosis.finishRun, {
      agentRunId,
      status: answer.ok ? "completed" : "failed",
      durationMs: Date.now() - started,
      ...(noModel && {
        error: `${noModel} The step used a rule-based reading of the facts instead.`,
      }),
    });
    const reading = answer.ok ? answer.reading : ruleReading(facts, gathered);
    const percent = Math.round(reading.confidence * 100);
    const revisionText =
      typeof facts["app.revision"] === "string" ? facts["app.revision"] : null;

    const [evidenceId]: Id<"evidence">[] = await ctx.runMutation(
      internal.protectedApp.records.addEvidence,
      {
        rows: [
          evidenceRow(input, revisionOf(revisionText, base), {
            kind: "diagnosis",
            title: answer.ok
              ? `Likely cause, from ${model} (confidence ${percent}%)`
              : `Rule-based reading, not a model's diagnosis (confidence ${percent}%)`,
            body: noModel ? `${reading.cause}\n\n${noModel}` : reading.cause,
            sourceRef: answer.ok
              ? `agentRuns/${agentRunId}`
              : "rule-based reading of the facts",
          }),
        ],
      },
    );
    const diagnosis = {
      source: answer.ok ? ("model" as const) : ("rules" as const),
      cause: reading.cause,
      confidence: reading.confidence,
      supportingEvidenceIds: reading.supportingEvidenceIds,
      supportingFactKeys: reading.supportingFactKeys,
      modelId: answer.ok ? model : null,
      noModelReason: answer.ok ? null : answer.reason,
    };
    return {
      status: "done",
      summary: answer.ok
        ? `Likely cause (${model}, confidence ${percent}%): ${reading.cause}`
        : `${noModel} A rule-based reading of the facts says: ${reading.cause}`,
      handoff: {
        note: answer.ok
          ? "A model's diagnosis is in this attempt's output."
          : "No model answered; a rule-based reading is in this attempt's output.",
        refs: [
          { kind: "evidence", id: evidenceId, label: "diagnosis" },
          { kind: "agentRun", id: agentRunId },
        ],
      },
      output: { diagnosis, agentRunId, evidenceId },
    };
  },
};
