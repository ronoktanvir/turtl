import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import type { CaseDetail, CaseSummary, Citation, Enactment, FixOption, LogLine, OverviewBlock, PlanStep, PullRequest, Screenshot, Span, StructuralFinding, Visualization } from "../types";

export type CaseCards = NonNullable<FunctionReturnType<typeof api.cases.cards>>;
export type CaseFixes = FunctionReturnType<typeof api.fixes.forCase>;
export type CustomerReports = FunctionReturnType<typeof api.intake.records.forCase>;
export type CaseStructural = FunctionReturnType<typeof api.structural.queries.forCase>;

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

// A case the monitor opened because the app stopped answering turtl's checks: convex/constants.ts isNotAnsweringCase,
// kept here so this file has no runtime import (see plainWords below). Open, its status is waiting_for_app.
const isNotAnswering = (row: Pick<Doc<"cases">, "signature" | "status">) => row.signature?.startsWith("not_answering:") === true || row.status === "waiting_for_app";

export function mapCaseSummary(row: Doc<"cases">, number: number, pullRequest?: PullRequest | null): CaseSummary {
  const quiet = isNotAnswering(row);
  const status: CaseSummary["status"] = row.status === "waiting_for_app" ? "not_answering" : row.status === "waiting_for_owner" ? "needs_approval"
    : row.status === "executing" || row.status === "waiting_for_deploy" || row.status === "verifying"
      ? pullRequest?.state === "open" && pullRequest.checks === "passing" && pullRequest.mergeable ? "ready_to_merge" : "enacting"
      : row.status === "restored" || row.status === "resolved" ? "resolved"
        : row.status === "declined" || row.status === "unresolved" ? row.status : "investigating";
  // A not-answering case closed because turtl stopped checking: turtl does not know whether users are affected, and the
  // owner has the next step (its reason says what), so it needs them.
  const health: CaseSummary["health"] = status === "resolved" || status === "declined" ? "clear"
    : quiet && status === "unresolved" ? "needs_you"
    : (status === "unresolved" && row.kind !== "feature_request") || row.kind === "outage" || status === "not_answering" ? "affected"
      : status === "needs_approval" || status === "ready_to_merge" || status === "unresolved" ? "needs_you" : "working";
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
    ...(row.starred && { starred: true }),
    ...(quiet && { notAnswering: true as const }),
    ...(row.kind === "feature_request"
      ? row.distinctRequesterCount !== undefined && { reportCount: row.distinctRequesterCount }
      : row.reportCount !== undefined && { reportCount: row.reportCount }),
  };
}

// Owners never read raw ids (TUR-72). data/workflow.ts keeps the same two helpers for the Plan graph; this file
// stays free of runtime imports so the node tests can load it directly.
export function plainWords(id: string): string {
  return id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function nameSteps(text: string, steps: { key: string; purpose?: string; title: string }[]): string {
  const names = new Map<string, string>();
  for (const step of steps) {
    for (const id of [step.key, step.purpose]) if (id && /[_-]/.test(id) && !names.has(id)) names.set(id, step.title);
  }
  if (!names.size) return text;
  const ids = [...names.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(?<![\\w-])(${ids.join("|")})(?![\\w-])`, "g"), (id) => `“${names.get(id)}”`);
}

const evidenceWords: Record<string, string> = {
  journey_check: "Journey check",
  http_check: "Web check",
  health: "App health",
  flags: "App settings",
  revision: "App version",
  errors: "Error window",
  customer_report: "Customer report",
  memory_match: "What turtl remembered",
  diagnosis: "Diagnosis",
  agent_handoff: "Handed up",
  council: "Other models",
  action: "Action",
  verification: "Check after the fix",
};
const taskWords: Record<string, string> = {
  diagnose_outage: "diagnosis",
  council_member: "second opinion",
  council_consolidation: "second opinions combined",
  propose_fixes: "fix ideas",
  examine_broader_causes: "deeper cause",
  triage_customer_report: "customer report",
  case_chat_answer: "chat answer",
};
const actionWords: Record<string, string> = {
  set_feature_flag: "Change an app setting",
  open_pull_request: "Open a pull request",
};
const verdictWords: Record<string, string> = { passed: "passed", failed: "failed", inconclusive: "could not tell" };
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const named = (words: Record<string, string>, id: string) => words[id] ?? capitalized(plainWords(id));
const criterionLine = (status: string, id: string, summary?: string) =>
  `${status === "uncovered" ? "Not covered" : status === "passed" ? "Passed" : "Failed"} — ${plainWords(id)}${summary ? ": " + ownerWords(summary) : ""}`;
// Where a piece of evidence came from, in an owner's words: never a request line, a table name or an id.
const SOURCES: [RegExp, string][] = [
  [/^GET \/health\b/, "the app's health check"],
  [/^GET \/flags\b/, "the app's settings"],
  [/^GET \/revision\b/, "the version the app reports"],
  [/^GET \/errors\b/, "the app's record of recent failures"],
  [/^POST \/journey-check\b/, "turtl's check of the journey"],
  [/^code:/, "the project's code"],
  [/^cases\//, "an earlier case"],
  [/^recoveryMemories\//, "a recovery turtl remembers"],
  [/^agentRuns\//, "turtl's own work on this case"],
  [/^reports\//, "a customer's report"],
  [/^Revyl /, "a test run on a device"],
];
const COPY_PREFIX = /^(?:Copied from an earlier step: |Derived from evidence\/[^;]*; stepAttempts\/[^;]*; )/;
export function plainSource(sourceRef: string): string | null {
  const ref = sourceRef.replace(COPY_PREFIX, "").trim();
  for (const [pattern, words] of SOURCES) if (pattern.test(ref)) return words;
  // Anything else is shown only when it carries no id or request line.
  return ref && !/[a-z0-9]{16,}|\/|^[A-Z]+ /.test(ref) ? ref : null;
}

/** The original a gather step's copy of evidence stands for: copyOf, or the id in an older copy's sourceRef. */
export function copiedFrom(row: { copyOf?: string; sourceRef?: string }): string | undefined {
  return row.copyOf ?? /^Derived from evidence\/([^;]+);/.exec(row.sourceRef ?? "")?.[1];
}

// Text meant for an owner, from collectors and checks: an error code in brackets after the words that already say
// what failed ("(RECOMMENDATIONS_TIMEOUT)") is dropped, and a raw health flag reads as a sentence.
export function ownerWords(value: string): string {
  return value
    .replace(/\s*\((?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+\)/g, "")
    .replace(/reports health ok is true\b/g, "says it is healthy")
    .replace(/reports health ok is false\b/g, "says it is not healthy");
}

// A recorded journey check's body for the Logs: step names in words, the error without its code, and no run id.
export function journeyBodyWords(body: string): string {
  return body
    .split("\n")
    .map((line) => line
      .replace(/^([a-z][a-z0-9_]*): (passed|failed|skipped)\. /, (_all, name: string, verdict: string) => `${capitalized(plainWords(name))}: ${verdict}. `)
      .replace(/^Error [A-Z][A-Z0-9_]*: /, "Error: ")
      .replace(/\s*Run \S+ on revision \S+\.$/, ""))
    .join("\n");
}

// The refusals convex/protectedApp/watched.ts writes when nothing may be sent: the project's address (target) or its
// control token (TOKEN_WORDS).
const UNREACHABLE = /so turtl sent nothing|no control token is set for this project|could not open this project's control token|cannot open stored tokens on this backend/;

// Why a remembered recovery does not apply, from convex/memory/checks.ts's lines ("Required condition failed:
// journey.errorCode equals \"RECOMMENDATIONS_TIMEOUT\"; observed \"BOOKING_STORE_UNAVAILABLE\".") in words. The stored lines
// stay as they are: the feed reads them too.
const FACT_WORDS: Record<string, string> = {
  "journey.errorCode": "the error",
  "journey.failedStep": "where the booking stopped",
  "journey.verdict": "the booking check",
  "flags.recommendationsEnabled": "recommendations",
  "health.ok": "whether the app answered",
  "app.revision": "the app's version",
  "errors.topCode": "the most common error",
};
const valueWords = (raw: string) => {
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* left as written */ }
  if (value === true) return "on";
  if (value === false) return "off";
  return String(value).replace(/_+/g, " ").toLowerCase();
};
export function recoveryMismatchWords(body: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^(?:Required condition failed|Do not use this recovery): (\S+) (?:equals|does not equal|is less than|is at most|is greater than|is at least) (.+); observed (.+)\.$/.exec(line.trim());
    if (!match) { if (line.trim()) out.push(line.trim()); continue; }
    const [, field, expected, observed] = match;
    if (seen.has(field)) continue;
    seen.add(field);
    const what = FACT_WORDS[field] ?? "one condition";
    out.push(`It was for ${what} being ${valueWords(expected)}; this time it is ${valueWords(observed)}.`);
  }
  return out.join("\n");
}

// Detecting and gathering each run the booking check and the health check, so a case holds two of each. They are
// separate observations, both kept; each says when turtl made it so neither reads as a duplicate.
const AGAIN = { source: "when turtl looked again", lead: "Looking again, to gather what it knows: " };
const WHEN: Record<string, { source: string; lead: string }> = {
  detect_or_receive: { source: "when turtl first noticed", lead: "When turtl first noticed: " },
  // The two readers that run beside each other after detecting, and the step that gathers what they read.
  collect_app_state: AGAIN,
  collect_error_window: AGAIN,
  gather_context: AGAIN,
};
export function whenObserved(purpose: string | undefined): { source: string; lead: string } | null {
  return (purpose && WHEN[purpose]) || null;
}

/** What an unresolved case says when it stopped because turtl could not reach the app at all. */
export function unreachableStop(stepTitle: string): string {
  return `turtl stopped this case because it could not reach your app, so it sent nothing. The reason is under "${stepTitle}" below: usually the project's control token is missing, or its live address is one turtl may not send to. Fix it in this project's Settings. turtl's next check opens a new case if the problem is still there, and a new report from a customer does too. This case stays closed.`;
}

// A model reason that names a deployment setting reads as "no model is connected" to an owner. The outage diagnosis's
// reason already begins "No model answered" (convex/runner/handlers/investigate.ts), and the line that shows it says
// so itself, so it is said once.
const plainModelReason = (reason: string) => {
  const bare = reason.replace(/^No model answered\s*[:.]?\s*/i, "").trim();
  return /_API_KEY|_KEY\b/.test(bare) ? "turtl has no model connected yet" : bare;
};

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
    steps.push({ label: capitalized(plainWords(match[1])) + (match[2] === "skipped" ? " (skipped)" : ""), state: match[2] === "skipped" ? "not_reached" : match[2] as "passed" | "failed" });
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
      detail: nameSteps([step.status === "waiting" ? "Waiting." : "", step.skipReason, attempt?.handoff, attempt?.error].filter(Boolean).join(" "), cards.steps) || undefined,
      summary: attempt?.summary && ownerWords(nameSteps(attempt.summary, cards.steps)),
      // The approval step's attempt opens when turtl starts waiting for the owner. What it did starts at the approval,
      // which is when the action was requested, so its time is counted from there.
      startedAt: step.purpose === "authorize_and_execute" && cards.action ? Math.max(cards.action.requestedAt, attempt?.startedAt ?? 0) : attempt?.startedAt,
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

// What a not-answering case says (convex/protectedApp/notAnswering.ts). turtl cannot look into an app it cannot reach,
// so the case says what turtl saw, where the owner can look, and how it ends; nothing on it is a fix, an approval or an
// investigation. Once closed, what its one step recorded when it closed leads, and what turtl saw follows.
const QUIET_OPEN = [
  "turtl cannot propose a fix for an app it cannot reach, so this case has nothing for you to approve. Three places to look:",
  "Your host's status page. An outage there takes your app down with it.",
  "Your last deploy. If the app stopped answering soon after it, start with what that deploy changed.",
  "Your app's address. Open it yourself: if it loads for you, the part of the app turtl checks may be what is down.",
  // The monitor spaces out the checks of a project that keeps failing the same way (convex/protectedApp/watching.ts,
  // FAILING_STEPS_MS), down to every 15 minutes.
  "turtl keeps checking, less often the longer the app stays quiet, until it checks every 15 minutes. When the app answers, turtl closes this case itself and tells you.",
];
const QUIET_ANSWERED = "turtl closed this case itself when the app answered. It changed nothing on your app.";
const QUIET_STOPPED = "If turtl checks this project again and the app still gives no answer, turtl opens a new case and tells you.";
const WAIT_STEP_KEY = "wait_for_answer";
// The closing summary's last sentence when every check passed as the app came back (notAnswering.ts, nowWords).
// Anything else (a check failing, or still no answer) is not all clear.
const ALL_PASS = /Its checks pass now\.$/;
// "At least three tries…" continues a sentence after "When this case opened, ".
const continuing = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

function notAnsweringDetail(cards: CaseCards, number: number | undefined): CaseDetail {
  const row = cards.case;
  const step = cards.steps.find((candidate) => candidate.key === WAIT_STEP_KEY);
  const attempt = step?.currentAttempt;
  const output = record(attempt?.output);
  const since = typeof output.quietSince === "number" ? output.quietSince : row._creationTime;
  const closed = row.status !== "waiting_for_app" && row.status !== "open";
  const answered = typeof output.answered === "boolean" ? output.answered : row.status === "resolved";
  const closedAt = typeof output.closedAt === "number" ? output.closedAt : attempt?.finishedAt;
  const ending = closed && step?.status === "done" ? attempt?.summary : undefined;
  const summary = !closed ? row.impact || row.title
    : ending || (answered ? "The app answered turtl's checks again." : "turtl stopped checking this project, so it closed this case.");
  const texts = !closed ? QUIET_OPEN : [...(row.impact ? [`When this case opened, ${continuing(row.impact)}`] : []), answered ? QUIET_ANSWERED : QUIET_STOPPED];
  const base = mapCaseSummary(row, number ?? 0);
  // Answered again is all clear only when every check passed; a check that fails as the app comes back reads as a
  // failing check does anywhere else.
  const health: CaseDetail["health"] = base.status === "resolved" && !ALL_PASS.test(ending ?? "") ? "affected" : base.health;

  // What turtl recorded stays in the Logs, under each step's name.
  const names = cards.steps.map((one) => ({ key: one.key, purpose: one.purpose, title: one.title }));
  const logs: LogLine[] = [];
  for (const one of cards.steps) {
    const tried = one.currentAttempt;
    const note = tried && ownerWords(nameSteps([tried.summary, tried.error, tried.handoff].filter(Boolean).join("\n"), names));
    if (!tried || !note) continue;
    logs.push({ id: `attempt:${tried._id}`, at: tried.finishedAt ?? tried.startedAt ?? tried._creationTime, level: tried.error || tried.status === "failed" ? "error" : "info", source: `Workflow · ${one.title} · attempt ${tried.attempt}`, text: note });
  }
  return {
    ...base,
    health,
    summary,
    overview: texts.map((text) => ({ kind: "paragraph", spans: [{ text }] })),
    citations: logs.map((log) => ({ id: log.id, kind: "log", logId: log.id })),
    logs: logs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    code: [],
    screenshots: [],
    fixes: [],
    quiet: closed ? { since, ...(closedAt !== undefined && { closedAt }), answered } : { since },
  };
}

export function mapCaseDetail(
  cards: CaseCards,
  fixesResult: CaseFixes | undefined,
  request: PullRequest | null | undefined,
  screenshots: Screenshot[] | undefined,
  number: number | undefined,
  customerReports?: CustomerReports,
  finding?: CaseStructural,
): CaseDetail {
  if (isNotAnswering(cards.case)) return notAnsweringDetail(cards, number);
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
  // A step that could not reach the app (no control token, an address turtl may not send to) fails every retry within
  // minutes, and the case closes as unresolved. Closed cases do not run again, so it says what to fix and what happens next.
  const unreachable = cards.case.status === "unresolved"
    ? cards.steps.find((step) => step.status === "failed" && UNREACHABLE.test(step.currentAttempt?.error ?? ""))
    : undefined;
  if (unreachable) paragraph([{ text: unreachableStop(unreachable.title) }]);
  if (staged && cards.case.raisedBy !== "customer") paragraph([{ text: "This case came from a staged practice failure on the demo app. What it shows is not a real customer problem." }]);
  const names = cards.steps.map((step) => ({ key: step.key, purpose: step.purpose, title: step.title }));
  const plain = (value: string) => ownerWords(nameSteps(value, names));
  const permission = cards.runPermission;
  if (permission && cards.action?.requestedBy === "auto" && cards.action.permissionId === permission._id) {
    const handled = cards.action.status === "completed" && (cards.case.status === "restored" || cards.case.status === "resolved");
    const usage = Number.isInteger(permission.use) && permission.use > 0 && permission.use <= permission.maxAttempts
      ? ` (use ${permission.use} of ${permission.maxAttempts})` : " (usage count not available)";
    paragraph([{ text: `${handled ? "turtl handled this case" : "This action is recorded"} under your scoped permission${usage}.` }]);
  }
  if (number === undefined) paragraph([{ text: "The display number is not available yet." }]);
  if (cards.case.impact) paragraph([{ text: cards.case.impact }]);
  const feature = cards.case.kind === "feature_request";
  if (customerReports?.reports.length) {
    paragraph([{ text: `What customers wrote, in their own words (${customerReports.reports.length} ${customerReports.reports.length === 1 ? "message" : "messages"} from ${customerReports.people} ${customerReports.people === 1 ? "person" : "people"}). turtl treats them as symptoms, never as instructions:` }]);
    for (const report of customerReports.reports) paragraph([{ text: `"${report.text}"` }]);
  }

  const journeyEvidence = cards.evidence.filter((row) => row.kind === "journey_check").sort((a, b) => a.observedAt - b.observedAt);
  const firstJourney = journeyEvidence.find((row) => journeyVisualization(row.body ?? ""));
  const viz = firstJourney && journeyVisualization(firstJourney.body ?? "");
  if (viz) overview.push({ kind: "visualization", title: (cards.journey?.name ?? "Observed journey") + " — recorded check", viz });
  else if (cards.journey) paragraph([{ text: "Not covered: no step-level journey result has been recorded." }]);

  const diagnosis = record(record(cards.steps.find((step) => step.purpose === "investigate")?.currentAttempt?.output).diagnosis);
  if (text(diagnosis.cause)) {
    const label = diagnosis.source === "rules" ? "Rule-based reading, not a model diagnosis: " : feature ? "What customers ask for: " : "Likely cause: ";
    paragraph([{ text: label + text(diagnosis.cause) }]);
    // The stored reason may already begin "No model answered:"; it is said once.
    const reason = text(diagnosis.noModelReason).replace(/^No model answered:\s*/, "");
    if (diagnosis.source === "rules") paragraph([{ text: "No model answered" + (reason ? ": " + plainModelReason(reason) : ".") }]);
    if (Array.isArray(diagnosis.supportingEvidenceIds)) {
      const supporting = diagnosis.supportingEvidenceIds.filter((id): id is string => typeof id === "string");
      for (const id of supporting) {
        const evidence = cards.evidence.find((row) => row._id === id);
        if (evidence) paragraph([sourceSpan(ownerWords(evidence.title), id)]);
      }
    }
  }

  const structural: StructuralFinding | undefined = finding ? {
    ...finding,
    evidence: finding.evidence.map(({ cite, ...item }) => ({ ...item, ...(cite && evidenceIds.has(cite) && { cite }) })),
    change: { ...finding.change },
    test: { ...finding.test },
    ...(finding.check && { check: { ...finding.check } }),
  } : undefined;

  for (const evidence of cards.evidence) {
    // A gather step's copy of evidence already on this case is shown once, as its original; citing it opens that.
    const original = copiedFrom(evidence);
    if (original && original !== evidence._id && evidenceIds.has(original)) {
      citations.push({ id: evidence._id, kind: "log", logId: original });
      continue;
    }
    const from = evidence.sourceRef ? plainSource(evidence.sourceRef) : null;
    const when = whenObserved(cards.steps.find((step) => step._id === evidence.stepId)?.purpose);
    logs.push({ id: evidence._id, at: evidence.observedAt, level: "info", source: `Evidence · ${named(evidenceWords, evidence.kind)}${when ? " · " + when.source : ""}`, text: [ownerWords(evidence.title), evidence.body && (evidence.kind === "journey_check" ? journeyBodyWords(evidence.body) : evidence.kind === "memory_match" ? recoveryMismatchWords(evidence.body) : evidence.body), from && `From ${from}.`].filter(Boolean).join("\n") });
    citations.push({ id: evidence._id, kind: "log", logId: evidence._id });
    if (evidence.kind === "customer_report" && customerReports?.reports.length) continue;
    paragraph([...(when ? [{ text: when.lead }] : []), sourceSpan(ownerWords(evidence.title), evidence._id)]);
  }

  for (const step of cards.steps) {
    const attempts = step.purpose === "authorize_and_execute" && cards.executeAttempts.length
      ? cards.executeAttempts : step.currentAttempt ? [step.currentAttempt] : [];
    for (const attempt of attempts) {
      const note = plain([attempt.summary, attempt.error, attempt.handoff].filter(Boolean).join("\n"));
      if (!note) continue;
      const id = `attempt:${attempt._id}`;
      logs.push({ id, at: attempt.finishedAt ?? attempt.startedAt ?? attempt._creationTime, level: attempt.error || attempt.status === "failed" ? "error" : "info", source: `Workflow · ${step.title} · attempt ${attempt.attempt}`, text: note });
      citations.push({ id, kind: "log", logId: id });
      paragraph([{ text: `${step.title} (attempt ${attempt.attempt}): ${plain(attempt.summary ?? attempt.error ?? attempt.handoff ?? "")}`, cite: id }]);
    }
    if (step.status === "skipped" && step.skipReason) paragraph([{ text: `${step.title}: skipped. ${plain(step.skipReason)}` }]);
  }

  for (const run of cards.agentRuns) {
    const id = `agent:${run._id}`;
    logs.push({ id, at: run._creationTime, level: run.status === "failed" ? "error" : "info", source: `Agent run · ${named(taskWords, run.taskType)}`, text: [`${run.status} (${run.config.modelId})`, run.error].filter(Boolean).join("\n") });
    citations.push({ id, kind: "log", logId: id });
    if (run.error) paragraph([{ text: run.error, cite: id }]);
  }

  if (cards.action) {
    const action = cards.action;
    const id = `action:${action._id}`;
    logs.push({ id, at: action.completedAt ?? action.startedAt ?? action.requestedAt, level: action.status === "failed" ? "error" : action.status === "unknown" ? "warn" : "info", source: `Action · ${named(actionWords, action.type)}`, text: [action.status, action.result].filter(Boolean).join("\n") });
    citations.push({ id, kind: "log", logId: id });
    if (action.result) paragraph([{ text: `${named(actionWords, action.type)} (${action.status}): ${action.result}`, cite: id }]);
  }

  for (const verification of [...cards.verifications].sort((a, b) => a.completedAt - b.completedAt)) {
    const phase = verification.phase === "before" ? "Before any change" : verification.phase === "after_fix" ? "After the action" : "After deployment";
    const id = `verification:${verification._id}`;
    const criteria = verification.criterionResults.map((result) => criterionLine(result.status, result.criterionId, result.summary));
    const missing = verification.coverage.uncoveredCriterionIds.filter((criterionId) => !verification.criterionResults.some((result) => result.criterionId === criterionId));
    for (const criterionId of missing) criteria.push(criterionLine("uncovered", criterionId));
    const verdict = verdictWords[verification.verdict] ?? verification.verdict;
    logs.push({ id, at: verification.completedAt, level: verification.verdict === "failed" ? "error" : verification.verdict === "inconclusive" ? "warn" : "info", source: `Check · ${phase}`, text: [`${phase} — ${verdict}: ${ownerWords(verification.summary)}`, ...criteria].join("\n") });
    citations.push({ id, kind: "log", logId: id });
    paragraph([{ text: `${phase} — ${verdict}: ${ownerWords(verification.summary)}`, cite: id }]);
    for (const result of verification.criterionResults) {
      const spans: Span[] = [{ text: criterionLine(result.status, result.criterionId, result.summary) }];
      for (const evidenceId of result.evidenceIds) {
        const evidence = cards.evidence.find((row) => row._id === evidenceId);
        if (evidence) spans.push(sourceSpan(` ${ownerWords(evidence.title)}`, evidenceId));
      }
      paragraph(spans);
    }
    for (const criterionId of missing) paragraph([{ text: criterionLine("uncovered", criterionId) }]);
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
    staged ? "What turtl remembers from this staged practice failure:" : "What turtl remembers:",
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
    ...(structural && { structural }),
    ...(cards.case.raisedBy === "customer" && { raisedByCustomers: true }),
  };
}
