import type { Doc } from "../../convex/_generated/dataModel";
import type { AgentRunView, AgentWork, CaseDetail, CouncilView } from "../types";

type RunRow = Doc<"agentRuns">;
type ReviewRow = Doc<"councilReviews">;

const tasks: Record<string, AgentRunView["task"]> = {
  diagnose_outage: "diagnosis",
  council_member: "council_member",
  council_consolidate: "council_consolidation",
};

const outcomeWords: Record<NonNullable<AgentRunView["outcome"]>, string> = {
  verified: "Verified: the fix it led to passed its check",
  corrected: "Corrected by you",
  failed: "Did not establish the cause",
  infra_failure: "Infrastructure failure, not counted against it",
};

export function money(costUsd: number | undefined): string {
  if (costUsd === undefined) return "cost unknown";
  return costUsd < 0.01 ? "under 1¢" : "$" + costUsd.toFixed(2);
}

export function seconds(durationMs: number | undefined): string {
  if (durationMs === undefined) return "still running";
  return durationMs < 1000 ? "under a second" : Math.round(durationMs / 1000) + " s";
}

export function mapAgentRun(run: RunRow, stepKey: string, labels: Map<string, string>): AgentRunView {
  const routing = run.routing;
  return {
    id: run._id,
    stepKey,
    task: tasks[run.taskType] ?? "other",
    configuration: routing?.configLabel ?? "Fixed configuration",
    model: run.config.modelId + (run.config.reasoning ? ` (${run.config.reasoning} reasoning)` : ""),
    reason: run.routingReason,
    ...(routing?.escalatedFromRunId && { handedUpFrom: labels.get(routing.escalatedFromRunId) ?? "an earlier run" }),
    ...(routing?.escalatedToRunId && { handedUpTo: labels.get(routing.escalatedToRunId) ?? "a stronger run" }),
    ...(routing?.handoff && { handoff: routing.handoff }),
    status: run.status === "completed" ? "completed" : run.status === "failed" || run.status === "cancelled" ? "failed" : "running",
    ...(run.error && { error: run.error }),
    ...(run.outcome && { outcome: run.outcome }),
    ...(run.outcomeReason && { outcomeReason: run.outcomeReason }),
    ...(run.costUsd !== undefined && { costUsd: run.costUsd }),
    ...(run.durationMs !== undefined && { durationMs: run.durationMs }),
    startedAt: run._creationTime,
  };
}

export function mapAgentRuns(runs: RunRow[], steps: { _id: string; key: string }[]): AgentRunView[] {
  const keys = new Map(steps.map((step) => [step._id as string, step.key]));
  const labels = new Map(runs.map((run) => [run._id as string, run.routing?.configLabel ?? "Fixed configuration"]));
  return [...runs]
    .sort((a, b) => a._creationTime - b._creationTime)
    .map((run) => mapAgentRun(run, (run.stepId && keys.get(run.stepId)) || "", labels));
}

// The Logs tab's text for one run: configuration, why, handoff, cost, duration and outcome.
export function agentRunLogText(run: AgentRunView): string {
  return [
    `${run.configuration} · ${run.model} · ${run.status}`,
    `Why: ${run.reason}`,
    run.handedUpFrom && `Handed up from the ${run.handedUpFrom.toLowerCase()}.`,
    run.handedUpTo && `Handed its evidence up to the ${run.handedUpTo.toLowerCase()}.`,
    `${run.costUsd === undefined ? "Cost unknown" : `Cost ${money(run.costUsd)}`} · took ${seconds(run.durationMs)}`,
    run.outcome ? `Outcome: ${outcomeWords[run.outcome]}.` : run.outcomeReason ? run.outcomeReason : "Outcome: not known yet.",
    run.error,
  ].filter(Boolean).join("\n");
}

const memberOrder = { answered: 0, failed: 1, not_run: 2 } as const;

export function mapCouncil(review: ReviewRow | null | undefined): CouncilView | undefined {
  if (!review) return undefined;
  const consolidation = review.consolidation;
  return {
    id: review._id,
    status: review.status,
    notice: review.notice,
    ...(consolidation?.summary && { summary: consolidation.summary }),
    ...(review.skippedReason && { skippedReason: review.skippedReason }),
    agreements: consolidation?.agreements ?? [],
    disagreements: consolidation?.disagreements ?? [],
    missingEvidence: consolidation?.missingEvidence ?? [],
    members: [...review.members].sort((a, b) => memberOrder[a.status] - memberOrder[b.status]).map((member) => ({
      label: member.label,
      status: member.status,
      ...(member.hypothesis && { hypothesis: member.hypothesis }),
      ...(member.confidence !== undefined && { confidence: member.confidence }),
      ...(member.error && { note: member.error }),
    })),
    costUsd: review.costUsd,
    startedAt: review.startedAt,
  };
}

export function mapAgentWork(view: { steps: { _id: string; key: string }[]; runs: RunRow[]; council: ReviewRow | null }): AgentWork {
  const council = mapCouncil(view.council);
  return { runs: mapAgentRuns(view.runs, view.steps), ...(council && { council }) };
}

// Adds who worked on each step to a mapped case: the Logs tab's agent-run lines and each plan step's agents.
export function withAgentRuns(detail: CaseDetail, runs: RunRow[], steps: { _id: string; key: string }[]): CaseDetail {
  if (!runs.length) return detail;
  const views = mapAgentRuns(runs, steps);
  const byId = new Map(views.map((run) => [`agent:${run.id}`, run]));
  const logs = detail.logs.map((line) => {
    const run = byId.get(line.id);
    return run ? { ...line, source: `Agent run · ${run.configuration}`, text: agentRunLogText(run) } : line;
  });
  const enactment = detail.enactment && {
    ...detail.enactment,
    steps: detail.enactment.steps.map((step) => {
      const agents = views.filter((run) => run.stepKey === step.key);
      return agents.length ? { ...step, agents } : step;
    }),
  };
  return { ...detail, logs, ...(enactment && { enactment }) };
}
