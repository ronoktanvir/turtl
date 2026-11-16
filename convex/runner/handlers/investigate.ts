import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { gateFor, type Gate } from "../../consent/gate";
import { examineWithCouncil, type CouncilResult } from "../../council/run";
import {
  askModel,
  modelFor,
  ruleReading,
  traitsFor,
  type DiagnosisContext,
  type EvidenceSummary,
  type Reading,
} from "../../diagnosis";
import { readPastCaseNotes } from "../../memory/service";
import { revisionOf } from "../../protectedApp/client";
import { CONFIGURATIONS, DIAGNOSIS_BUDGET_USD, PROVIDER_KEYS, type ConfigKey } from "../../routing/configs";
import { DIAGNOSIS_TASK } from "../../routing/log";
import { describeModel, providerKey } from "../../routing/models";
import { selectConfiguration, unsupportedReasons, type Selection, type Traits } from "../../routing/selector";
import type { HandlerInput, StepHandler } from "../contract";
import { evidenceRow, loadJourneyContext, type Facts } from "./journey";

const TIMEOUT_MS = 300_000;
// Kept free for a council run (members in parallel, then consolidation) after the diagnosis runs.
const COUNCIL_RESERVE_MS = 150_000;

type Run = {
  configKey: ConfigKey;
  agentRunId: Id<"agentRuns">;
  reading: Reading | null;
  noModel: string | null;
  infra: boolean;
  blocked: boolean;
  costUsd: number;
  durationMs: number;
};

async function diagnose(
  ctx: ActionCtx,
  gate: Gate,
  input: HandlerInput,
  configKey: ConfigKey,
  reason: string,
  traits: Traits,
  selection: Selection,
  limits: { timeLeftMs: number; budgetLeftUsd: number },
  context: DiagnosisContext,
): Promise<Run> {
  const config = CONFIGURATIONS[configKey];
  const model = modelFor(config);
  const agentRunId: Id<"agentRuns"> = await ctx.runMutation(internal.routing.log.startRun, {
    caseId: input.case._id,
    stepId: input.step._id,
    stepAttemptId: input.attempt._id,
    taskType: DIAGNOSIS_TASK,
    config: {
      modelId: model.model,
      ...(model.reasoning && { reasoning: model.reasoning }),
      harnessVersion: config.harnessVersion,
      promptVersion: config.promptVersion,
      credentialRef: PROVIDER_KEYS[model.provider],
    },
    taskCharacteristics: {
      complexity: `difficulty ${selection.difficulty}: ${selection.difficultyFactors.join("; ") || "nothing raised it"}`,
      risk: `${traits.consequence} consequence: ${traits.consequenceWhy}`,
      framework: "Expo and Convex",
      repositoryArea: traits.components.join(", ") || "not identified",
    },
    routingReason: reason,
    routing: {
      configKey,
      configLabel: config.label,
      provider: model.provider,
      traits,
      bucket: selection.bucket,
      difficulty: selection.difficulty,
      limits,
    },
  });
  const { answer, reading, unusable } = await askModel(gate, config, context);
  const failure = !answer.ok ? answer.reason : unusable;
  const infra = !answer.ok && answer.infra;
  await ctx.runMutation(internal.routing.log.finishRun, {
    agentRunId,
    status: reading ? "completed" : "failed",
    durationMs: answer.durationMs,
    ...(answer.usage && { usage: answer.usage }),
    ...(answer.costUsd !== undefined && { costUsd: answer.costUsd }),
    ...(failure && {
      error: `No model answered: ${failure}. The step used a rule-based reading of the facts instead.`,
      outcome: infra ? ("infra_failure" as const) : ("failed" as const),
      outcomeReason: infra ? `Infrastructure, not reasoning: ${failure}.` : `The answer could not be used: ${failure}.`,
    }),
  });
  return {
    configKey,
    agentRunId,
    reading,
    noModel: failure ? `No model answered: ${failure}.` : null,
    infra,
    blocked: !answer.ok && !!answer.blocked,
    costUsd: answer.costUsd ?? 0,
    durationMs: answer.durationMs,
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const money = (value: number) => `$${value.toFixed(value < 0.01 ? 4 : 3)}`;

// Routes the diagnosis to a configuration chosen per case, hands an unsupported answer up to the stronger
// configuration as a new run, and asks the council when even that stays unsure on an unfamiliar case.
export const handler: StepHandler = {
  timeoutMs: TIMEOUT_MS,
  run: async (ctx, input) => {
    if (!input.case.journeyId) {
      return {
        status: "done",
        summary: "Placeholder: no investigation ran.",
        handoff: { note: "No findings to pass on: investigation is a placeholder.", refs: [] },
      };
    }
    const started = input.attempt.startedAt ?? Date.now();
    // Diagnosis of an outage the monitor found may use the part of the day kept for outages (convex/spend/README.md).
    const gate = gateFor(ctx, { caseId: input.case._id }, "outage");
    const loaded = await loadJourneyContext(ctx, input);
    if (!loaded.ok) return { status: "failed", error: loaded.reason };
    const { base, evidence, catalog } = loaded.context;
    const source = input.parents.find((p) => p.step.purpose === "gather_context")?.attempt;
    const facts = source?.output?.facts as Facts | undefined;
    if (!source || !facts) return { status: "failed", error: "gather_context handed over no facts." };
    const recall = ((source.output?.recall?.candidates ?? []) as { memoryId: string; applies: boolean; failedChecks: string[] }[]);
    const gathered: EvidenceSummary[] = evidence
      .filter((e) => e.stepAttemptId === source._id)
      .map((e) => ({ id: e._id, kind: e.kind, title: e.title, ...(e.body && { body: e.body }) }));

    const [past, history, spend] = await Promise.all([
      readPastCaseNotes(ctx, input.case, facts),
      ctx.runQuery(internal.routing.log.history, { taskType: DIAGNOSIS_TASK }),
      ctx.runQuery(internal.routing.log.caseSpend, { caseId: input.case._id }),
    ]);
    const traits = traitsFor({ row: input.case, facts, evidence: gathered, catalog, recall, verifiedFailures: history.verifiedFailures });
    const limitsNow = () => ({
      timeLeftMs: Math.max(0, TIMEOUT_MS - COUNCIL_RESERVE_MS - (Date.now() - started)),
      budgetLeftUsd: Math.max(0, DIAGNOSIS_BUDGET_USD - spend.diagnosis - runs.reduce((sum, run) => sum + run.costUsd, 0)),
    });
    const runs: Run[] = [];
    const firstLimits = limitsNow();
    const selection = selectConfiguration({ traits, limits: firstLimits, log: history.log, configs: CONFIGURATIONS });
    const context: DiagnosisContext = {
      facts,
      evidence: gathered,
      pastCases: past.notes,
      lookAlikes: recall.filter((item) => !item.applies).map((item) => ({ memoryId: item.memoryId, failedChecks: item.failedChecks })),
    };
    runs.push(await diagnose(ctx, gate, input, selection.configKey, selection.reason, traits, selection, firstLimits, context));

    let handoff: string | null = null;
    const first = runs[0];
    const firstConfig = CONFIGURATIONS[first.configKey];
    const stronger = firstConfig.escalatesTo && CONFIGURATIONS[firstConfig.escalatesTo];
    const kinds = Object.fromEntries(gathered.map((item) => [item.id, item.kind]));
    const firstReasons = first.reading ? unsupportedReasons(first.reading, facts, kinds) : [first.noModel ?? "it gave no answer"];
    if (firstReasons.length && stronger && !first.blocked && providerKey(modelFor(stronger).provider)) {
      handoff = `The ${firstConfig.label.toLowerCase()} could not establish a cause: ${firstReasons.join("; ")}.${
        first.reading ? ` Its reading was: "${first.reading.cause}" (confidence ${pct(first.reading.confidence)}).` : ""
      }${first.reading?.missingEvidence.length ? ` It said this is missing: ${first.reading.missingEvidence.join("; ")}.` : ""}`;
      const limits = limitsNow();
      const reason = `${stronger.label}: handed up. ${handoff}`;
      runs.push(await diagnose(ctx, gate, input, stronger.key, reason, traits, selection, limits, { ...context, handoff }));
      await ctx.runMutation(internal.routing.log.handUp, { fromRunId: first.agentRunId, toRunId: runs[1].agentRunId, handoff });
    }

    const final = runs[runs.length - 1];
    const finalConfig = CONFIGURATIONS[final.configKey];
    const reading = final.reading ?? runs.find((run) => run.reading)?.reading ?? null;
    const answered = !!final.reading;
    const used = reading ?? ruleReading(facts, gathered);
    const unsupported = answered ? unsupportedReasons(used, facts, kinds) : [];
    const unsure = !answered || unsupported.length > 0;

    let council: CouncilResult | null = null;
    if (answered && unsure && final.configKey === "careful" && traits.memory !== "matched") {
      council = await examineWithCouncil(ctx, {
        caseId: input.case._id,
        stepId: input.step._id,
        stepAttemptId: input.attempt._id,
        purpose: "diagnosis",
        question: "Why does this journey fail? The careful diagnosis could not establish a cause the evidence supports.",
        failure: traits.failure,
        facts,
        evidence: gathered,
        context: `Careful diagnosis (unsure): "${used.cause}" at ${pct(used.confidence)}. Missing, it said: ${used.missingEvidence.join("; ") || "nothing named"}.`,
      });
      if (council.reviewId) await ctx.runMutation(internal.routing.log.linkCouncil, { agentRunId: final.agentRunId, councilReviewId: council.reviewId });
    }

    const revisionText = typeof facts["app.revision"] === "string" ? facts["app.revision"] : null;
    const revision = revisionOf(revisionText, base);
    const who = `${finalConfig.label}, ${describeModel(modelFor(finalConfig))}`;
    const rows = [
      evidenceRow(input, revision, {
        kind: "diagnosis",
        title: !answered
          ? `Rule-based reading, not a model's diagnosis (confidence ${pct(used.confidence)})`
          : unsure
            ? `Unconfirmed cause, from ${who} (confidence ${pct(used.confidence)})`
            : `Likely cause, from ${who} (confidence ${pct(used.confidence)})`,
        body: [
          used.cause,
          unsupported.length ? `Not established: ${unsupported.join("; ")}.` : null,
          final.noModel,
          used.alternatives.length ? `Other explanations considered: ${used.alternatives.join("; ")}` : null,
          used.missingEvidence.length ? `Missing evidence: ${used.missingEvidence.join("; ")}` : null,
          `Why this configuration: ${final === first ? selection.reason : `handed up from the ${firstConfig.label.toLowerCase()}.`}`,
        ].filter(Boolean).join("\n\n"),
        sourceRef: answered ? `agentRuns/${final.agentRunId}` : "rule-based reading of the facts",
      }),
      ...(handoff
        ? [evidenceRow(input, revision, {
            kind: "agent_handoff",
            title: `The ${firstConfig.label.toLowerCase()} handed its evidence up to the ${finalConfig.label.toLowerCase()}`,
            body: handoff,
            sourceRef: `agentRuns/${first.agentRunId}`,
          })]
        : []),
      ...(council
        ? [evidenceRow(input, revision, {
            kind: "council",
            title: council.status === "completed" ? "Council of models: agreement is not proof" : "Council of models did not run",
            body: council.summary,
            sourceRef: council.reviewId ? `councilReviews/${council.reviewId}` : "council not recorded",
          })]
        : []),
    ];
    const evidenceIds: Id<"evidence">[] = await ctx.runMutation(internal.protectedApp.records.addEvidence, { rows });
    const cost = runs.reduce((sum, run) => sum + run.costUsd, 0) + (council?.costUsd ?? 0);
    const diagnosis = {
      source: answered ? ("model" as const) : ("rules" as const),
      cause: used.cause,
      confidence: used.confidence,
      supportingEvidenceIds: used.supportingEvidenceIds,
      supportingFactKeys: used.supportingFactKeys,
      modelId: answered ? modelFor(finalConfig).model : null,
      noModelReason: answered ? null : final.noModel,
      configKey: final.configKey,
      unsure,
      alternatives: used.alternatives,
      missingEvidence: used.missingEvidence,
    };
    const pastNote = answered || !past.notes.length ? past.summary : `${past.summary} No model answered, so they were not used.`;
    const route = handoff ? `${firstConfig.label} handed up to ${finalConfig.label}` : finalConfig.label;
    const councilNote = council ? ` ${council.status === "completed" ? `A council of models also examined it; agreement between them is not proof.` : council.summary}` : "";
    return {
      status: "done",
      summary: (answered
        ? `${unsure ? "Unconfirmed cause" : "Likely cause"} (${route}; ${modelFor(finalConfig).model}, confidence ${pct(used.confidence)}): ${used.cause}${unsupported.length ? ` Not established: ${unsupported.join("; ")}.` : ""}`
        : `${final.noModel} A rule-based reading of the facts says: ${used.cause}`) + `${councilNote} Model cost about ${money(cost)}. ${pastNote}`,
      handoff: {
        note: answered
          ? `A model's diagnosis is in this attempt's output${unsure ? "; it is unconfirmed" : ""}.${council?.status === "completed" ? " The council's consolidated view is an input, not verification." : ""}`
          : "No model answered; a rule-based reading is in this attempt's output.",
        refs: [
          { kind: "evidence", id: evidenceIds[0], label: "diagnosis" },
          ...runs.map((run) => ({ kind: "agentRun", id: run.agentRunId, label: CONFIGURATIONS[run.configKey].label })),
          ...(council?.reviewId ? [{ kind: "councilReview", id: council.reviewId }] : []),
        ],
      },
      output: {
        diagnosis,
        agentRunId: final.agentRunId,
        agentRunIds: runs.map((run) => run.agentRunId),
        evidenceId: evidenceIds[0],
        pastCaseIds: past.caseIds,
        routing: { selected: selection.configKey, reason: selection.reason, bucket: selection.bucket, escalated: !!handoff, final: final.configKey },
        ...(council && { council: { status: council.status, reviewId: council.reviewId, summary: council.summary } }),
      },
    };
  },
};
