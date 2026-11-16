import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import type { CaseDetail, CaseSummary, Citation, Enactment, FixOption, LogLine, OverviewBlock, PlanStep, PullRequest, Screenshot, Span, Visualization } from "../types";

export type CaseCards = NonNullable<FunctionReturnType<typeof api.cases.cards>>;
export type CaseFixes = FunctionReturnType<typeof api.fixes.forCase>;

export function mapPullRequest(value: PullRequest | null | undefined): PullRequest | undefined {
  if (!value) return undefined;
  return {
    repo: value.repo,
    number: value.number,
    title: value.title,
    url: value.url,
    headSha: value.headSha,
    state: value.state,
    checks: value.checks,
    checkRuns: value.checkRuns.map((run) => ({ ...run })),
    mergeable: value.mergeable,
  };
}

export function mapCaseSummary(row: Doc<"cases">, number: number, pullRequest?: PullRequest | null): CaseSummary {
  const status: CaseSummary["status"] = row.status === "waiting_for_owner" ? "needs_approval"
    : row.status === "executing" || row.status === "waiting_for_deploy" || row.status === "verifying"
      ? pullRequest?.state === "open" && pullRequest.checks === "passing" && pullRequest.mergeable ? "ready_to_merge" : "enacting"
      : row.status === "restored" || row.status === "resolved" ? "resolved"
        : row.status === "declined" || row.status === "unresolved" ? row.status : "investigating";
  const health: CaseSummary["health"] = status === "resolved" || status === "declined" ? "clear"
    : status === "unresolved" || row.kind === "outage" ? "affected"
      : status === "needs_approval" || status === "ready_to_merge" ? "needs_you" : "working";
  return {
    id: row._id,
    projectId: row.appId,
    type: row.kind === "feature_request" ? "feature" : "fix",
    number,
    title: row.title,
    category: row.kind === "bug_report" ? "bug" : row.kind,
    status,
    health,
    happenedAt: row._creationTime,
    ...(row.kind === "feature_request"
      ? row.distinctRequesterCount !== undefined && { reportCount: row.distinctRequesterCount }
      : row.reportCount !== undefined && { reportCount: row.reportCount }),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function journeyVisualization(body: string): Visualization | undefined {
  const steps: Extract<Visualization, { type: "journey" }>["steps"] = [];
  for (const line of body.split("\n")) {
    const match = /^([^:\n]+): (passed|failed|skipped)\. (.*)$/.exec(line);
    if (!match) continue;
    steps.push({ label: match[1] + (match[2] === "skipped" ? " (skipped)" : ""), state: match[2] === "skipped" ? "not_reached" : match[2] as "passed" | "failed" });
  }
  return steps.length ? { type: "journey", steps } : undefined;
}

function enactmentOf(cards: CaseCards, fixes: CaseFixes | undefined, pullRequest: PullRequest | undefined): Enactment | undefined {
  const fixKey = cards.action?.optionKey ?? fixes?.chosenKey ?? cards.proposal?.chosenKey;
  if (!fixKey) return undefined;
  const work = cards.steps.filter((step) => step.purpose === "authorize_and_execute" || step.purpose === "verify" || step.purpose === "learn");
  const steps: PlanStep[] = work.map((step) => {
    const attempt = step.currentAttempt;
    return {
      key: step.key,
      title: step.title,
      status: step.status === "waiting" ? "pending" : step.status,
      detail: [step.status === "waiting" ? "Waiting." : "", step.skipReason, attempt?.handoff, attempt?.error].filter(Boolean).join(" ") || undefined,
      summary: attempt?.summary,
      startedAt: attempt?.startedAt,
      finishedAt: attempt?.finishedAt,
    };
  });
  const latestVerification = cards.action && cards.verifications.filter((verification) => verification.phase !== "before"
    && verification.actionId === cards.action!._id).sort((a, b) => b.completedAt - a.completedAt)[0];
  const verified = latestVerification?.verdict === "passed"
    && latestVerification.criterionResults.some((result) => result.status === "passed")
    && !/staged|fixture/i.test(latestVerification.summary);
  let state: Enactment["state"] = "running";
  let question: string | undefined;
  if (cards.action?.status === "cancelled") state = "stopped";
  else if (cards.action?.status === "unknown") {
    state = "needs_you";
    question = cards.action.result ?? "The action's outcome is unknown. It must be reconciled before another execution.";
  } else if (cards.case.status === "unresolved" || cards.action?.status === "failed" || work.some((step) => step.status === "failed") || pullRequest?.state === "closed") state = "failed";
  else if ((cards.case.status === "restored" || cards.case.status === "resolved") && verified) state = "done";
  else if (cards.case.status === "restored" || cards.case.status === "resolved") {
    state = "needs_you";
    question = "Not covered: no non-staged passing verification for this action has been recorded. Completed workflow steps alone do not prove recovery.";
  } else if (pullRequest?.state === "merged") state = "merged";
  else if (pullRequest?.state === "open" && pullRequest.checks === "passing" && pullRequest.mergeable) state = "waiting_for_merge";
  else if (pullRequest?.state === "open" && (pullRequest.checks === "failing" || pullRequest.checks === "none" || pullRequest.checks === "passing")) {
    state = "needs_you";
    question = pullRequest.checks === "failing" ? "The pull request's checks failed. It is not ready to merge."
      : pullRequest.checks === "none" ? "Not covered: no pull-request checks have been reported."
        : "The pull request's checks passed, but GitHub has not reported it mergeable.";
  }
  else if (cards.case.status === "waiting_for_owner") {
    state = "needs_you";
    question = work.find((step) => step.status === "waiting")?.currentAttempt?.summary ?? "The workflow is waiting for the owner's decision.";
  }
  return { fixKey, state, steps, ...(pullRequest && { pullRequest }), ...(question && { question: { text: question, fixes: [] } }) };
}

export function mapCaseDetail(
  cards: CaseCards,
  fixesResult: CaseFixes | undefined,
  request: PullRequest | null | undefined,
  screenshots: Screenshot[] | undefined,
  number: number | undefined,
): CaseDetail {
  const pullRequest = mapPullRequest(request);
  const logs: LogLine[] = [];
  const citations: Citation[] = [];
  const overview: OverviewBlock[] = [];
  const paragraph = (spans: Span[]) => overview.push({ kind: "paragraph", spans });
  const evidenceIds = new Set(cards.evidence.map((row) => row._id as string));
  const sourceSpan = (value: string, evidenceId: string): Span => ({ text: value, ...(evidenceIds.has(evidenceId) && { cite: evidenceId }) });
  const httpCheck = cards.journey?.check;
  const bookingDemo = httpCheck?.kind === "http" && /\/booking-demo(?:\/|$)/.test(httpCheck.config.url);
  const staged = bookingDemo || cards.case.isSample || /staged|fixture/i.test(cards.case.title)
    || cards.steps.some((step) => step.staged || /staged|fixture/i.test(step.currentAttempt?.summary ?? ""));
  if (staged) paragraph([{ text: "Staged/demo case: these observations are not evidence of a real customer incident." }]);
  if (number === undefined) paragraph([{ text: "The display number is not available yet." }]);
  if (cards.case.impact) paragraph([{ text: cards.case.impact }]);

  const journeyEvidence = cards.evidence.filter((row) => row.kind === "journey_check").sort((a, b) => a.observedAt - b.observedAt);
  const firstJourney = journeyEvidence.find((row) => journeyVisualization(row.body ?? ""));
  const viz = firstJourney && journeyVisualization(firstJourney.body ?? "");
  if (viz) overview.push({ kind: "visualization", title: (cards.journey?.name ?? "Observed journey") + " — recorded check", viz });
  else if (cards.journey) paragraph([{ text: "Not covered: no step-level journey result has been recorded." }]);

  const diagnosis = record(record(cards.steps.find((step) => step.purpose === "investigate")?.currentAttempt?.output).diagnosis);
  if (text(diagnosis.cause)) {
    const label = diagnosis.source === "rules" ? "Rule-based reading, not a model diagnosis: " : "Likely cause: ";
    paragraph([{ text: label + text(diagnosis.cause) }]);
    if (diagnosis.source === "rules") paragraph([{ text: "No model answered" + (text(diagnosis.noModelReason) ? ": " + text(diagnosis.noModelReason) : ".") }]);
    if (Array.isArray(diagnosis.supportingEvidenceIds)) {
      const supporting = diagnosis.supportingEvidenceIds.filter((id): id is string => typeof id === "string");
      for (const id of supporting) {
        const evidence = cards.evidence.find((row) => row._id === id);
        if (evidence) paragraph([sourceSpan(evidence.title, id)]);
      }
    }
  }

  for (const evidence of cards.evidence) {
    logs.push({ id: evidence._id, at: evidence.observedAt, level: "info", source: `Evidence · ${evidence.kind} · ${evidence.environment}`, text: [evidence.title, evidence.body, evidence.sourceRef && `Source: ${evidence.sourceRef}`].filter(Boolean).join("\n") });
    citations.push({ id: evidence._id, kind: "log", logId: evidence._id });
    paragraph([sourceSpan(evidence.title, evidence._id)]);
  }

  for (const step of cards.steps) {
    const attempts = step.purpose === "authorize_and_execute" && cards.executeAttempts.length
      ? cards.executeAttempts : step.currentAttempt ? [step.currentAttempt] : [];
    for (const attempt of attempts) {
      const note = [attempt.summary, attempt.error, attempt.handoff].filter(Boolean).join("\n");
      if (!note) continue;
      const id = `attempt:${attempt._id}`;
      logs.push({ id, at: attempt.finishedAt ?? attempt.startedAt ?? attempt._creationTime, level: attempt.error || attempt.status === "failed" ? "error" : "info", source: `Workflow · ${step.title} · attempt ${attempt.attempt}`, text: note });
      citations.push({ id, kind: "log", logId: id });
      paragraph([{ text: `${step.title} (attempt ${attempt.attempt}): ${attempt.summary ?? attempt.error ?? attempt.handoff}`, cite: id }]);
    }
    if (step.status === "skipped" && step.skipReason) paragraph([{ text: `${step.title}: skipped. ${step.skipReason}` }]);
  }

  for (const run of cards.agentRuns) {
    const id = `agent:${run._id}`;
    logs.push({ id, at: run._creationTime, level: run.status === "failed" ? "error" : "info", source: `Agent run · ${run.taskType}`, text: [`${run.status} (${run.config.modelId})`, run.error].filter(Boolean).join("\n") });
    citations.push({ id, kind: "log", logId: id });
    if (run.error) paragraph([{ text: run.error, cite: id }]);
  }

  if (cards.action) {
    const action = cards.action;
    const id = `action:${action._id}`;
    logs.push({ id, at: action.completedAt ?? action.startedAt ?? action.requestedAt, level: action.status === "failed" ? "error" : action.status === "unknown" ? "warn" : "info", source: `Action · ${action.type}`, text: [action.status, action.result].filter(Boolean).join("\n") });
    citations.push({ id, kind: "log", logId: id });
    if (action.result) paragraph([{ text: `Action (${action.status}): ${action.result}`, cite: id }]);
  }

  for (const verification of [...cards.verifications].sort((a, b) => a.completedAt - b.completedAt)) {
    const phase = verification.phase === "before" ? "Before any change" : verification.phase === "after_fix" ? "After the action" : "After deployment";
    const id = `verification:${verification._id}`;
    const criteria = verification.criterionResults.map((result) => `${result.status === "uncovered" ? "Not covered" : result.status === "passed" ? "Passed" : "Failed"} — ${result.criterionId}: ${result.summary}`);
    const missing = verification.coverage.uncoveredCriterionIds.filter((criterionId) => !verification.criterionResults.some((result) => result.criterionId === criterionId));
    for (const criterionId of missing) criteria.push(`Not covered — ${criterionId}`);
    logs.push({ id, at: verification.completedAt, level: verification.verdict === "failed" ? "error" : verification.verdict === "inconclusive" ? "warn" : "info", source: `Verification · ${verification.environment}`, text: [`${phase} — ${verification.verdict}: ${verification.summary}`, ...criteria].join("\n") });
    citations.push({ id, kind: "log", logId: id });
    paragraph([{ text: `${phase} — ${verification.verdict}: ${verification.summary}`, cite: id }]);
    for (const result of verification.criterionResults) {
      const spans: Span[] = [{ text: `${result.status === "uncovered" ? "Not covered" : result.status === "passed" ? "Passed" : "Failed"} — ${result.criterionId}: ${result.summary}` }];
      for (const evidenceId of result.evidenceIds) {
        const evidence = cards.evidence.find((row) => row._id === evidenceId);
        if (evidence) spans.push(sourceSpan(` ${evidence.title}`, evidenceId));
      }
      paragraph(spans);
    }
    for (const criterionId of missing) paragraph([{ text: `Not covered — ${criterionId}` }]);
  }
  if (!cards.verifications.some((verification) => verification.phase !== "before")) paragraph([{ text: "Not covered: no after-action verification has been recorded. A completed step or a passing pull-request check is not proof of recovery." }]);
  paragraph([{ text: "Source code is not available in the recorded case evidence." }]);

  const knownCitations = new Set(citations.map((citation) => citation.id));
  const fixes: FixOption[] = (fixesResult?.fixes ?? []).map((fix) => ({
    ...fix,
    why: fix.why.map((span) => ({ text: span.text, ...(span.cite && knownCitations.has(span.cite) && { cite: span.cite }) })),
    codeIds: undefined,
  }));
  const enactment = enactmentOf(cards, fixesResult, pullRequest);
  const learnAttempt = cards.steps.find((step) => step.purpose === "learn")?.currentAttempt;
  const learnOutput = record(learnAttempt?.output);
  const caseNote = text(learnOutput.note) || text(learnOutput.summary) || learnAttempt?.summary;
  const memory = cards.learnedMemory;
  const learned = memory ? [
    staged ? "Staged/demo case — recorded recovery memory." : "Recorded recovery memory.",
    `Cause: ${memory.cause}`,
    ...(memory.conditions.length ? [`Conditions: ${memory.conditions.join("; ")}`] : []),
    ...(memory.notWhen.length ? [`Do not use when: ${memory.notWhen.join("; ")}`] : []),
    `Recorded verified recoveries: ${memory.timesVerified}.`,
    ...(memory.invalidatedAt !== undefined ? ["This recovery memory is invalidated."] : []),
  ].join("\n") : caseNote ? `Case-note text (not proof of recovery): ${caseNote}` : undefined;
  return {
    ...mapCaseSummary(cards.case, number ?? 0, pullRequest),
    summary: cards.case.impact || cards.case.title,
    overview,
    citations,
    logs: logs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    code: [],
    screenshots: (screenshots ?? []).map((shot) => ({ ...shot })),
    fixes,
    ...(enactment && { enactment }),
    ...(learned && { learned }),
  };
}
