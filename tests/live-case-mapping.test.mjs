import assert from "node:assert/strict";
import { test } from "node:test";
import { mapCaseDetail, mapCaseSummary, mapPullRequest } from "../data/live/caseMapping.ts";

const row = (fields = {}) => ({
  _id: "case-1", _creationTime: 1000, appId: "app-1", title: "Booking failed",
  impact: "A test booking could not be saved.", kind: "outage", raisedBy: "monitor", status: "investigating", ...fields,
});
const attempt = (fields = {}) => ({
  _id: "attempt-1", _creationTime: 1200, stepId: "step-1", caseId: "case-1", attempt: 1,
  status: "done", startedAt: 1200, finishedAt: 1400, summary: "Observed the failure.", ...fields,
});
const step = (fields = {}) => ({
  _id: "step-1", _creationTime: 1100, caseId: "case-1", key: "investigate", title: "Investigate",
  dependsOn: [], kind: "agent", purpose: "investigate", status: "done", currentAttempt: attempt(), ...fields,
});
const evidence = (fields = {}) => ({
  _id: "evidence-1", _creationTime: 1300, caseId: "case-1", stepId: "step-1", stepAttemptId: "attempt-1",
  kind: "journey_check", title: "The check failed.", sourceRef: "POST /journey-check (v1)",
  observedAt: 1250, environment: "protected-app", revision: { deploymentId: "v1" }, ...fields,
});
const action = (fields = {}) => ({ _id: "action-1", optionKey: "recover", type: "set_feature_flag", status: "completed", requestedAt: 1450, ...fields });
const verification = (fields = {}) => ({
  _id: "verification-1", _creationTime: 1600, caseId: "case-1", actionId: "action-1", stepAttemptId: "attempt-verify",
  phase: "after_fix", environment: "protected-app", revision: { deploymentId: "v1" },
  checkVersion: "v1", criteriaVersion: "v1", startedAt: 1500, completedAt: 1600, verdict: "passed",
  summary: "The server check saved a test booking.", evidenceIds: ["evidence-1"],
  criterionResults: [{ criterionId: "journey", status: "passed", summary: "Saved and checked a test booking.", evidenceIds: ["evidence-1"] }],
  coverage: { coveredCriterionIds: ["journey"], uncoveredCriterionIds: [] }, ...fields,
});
const cards = (fields = {}) => ({
  case: row(), journey: null, steps: [], executeAttempts: [], evidence: [], proposal: null,
  action: null, verifications: [], agentRuns: [], ...fields,
});
const pullRequest = (fields = {}) => ({
  repo: "owner/app", number: 9, title: "Decouple recommendations", url: "https://github.com/owner/app/pull/9",
  headSha: "abc123", state: "open", checks: "pending", checkRuns: [{ name: "Build", status: "pending" }],
  mergeable: false, ...fields,
});
const fix = (fields = {}) => ({
  key: "recover", title: "Turn off recommendations", kind: "recovery", recommended: true,
  why: [{ text: "Booking need not wait." }], whatChanges: "Disables suggestions.", whatMightBeLost: "Suggestions.",
  howChecked: "Run the booking check.", delivery: "action", ...fields,
});
const content = (detail) => detail.overview.filter((block) => block.kind === "paragraph").flatMap((block) => block.spans.map((span) => span.text)).join("\n");
const map = (value, fixes, pr, shots, number = 3) => mapCaseDetail(value, fixes, pr, shots, number);

test("case status and health reflect unresolved impact rather than workflow completion", () => {
  const statuses = {
    open: "investigating", investigating: "investigating", waiting_for_owner: "needs_approval",
    executing: "enacting", waiting_for_deploy: "enacting", verifying: "enacting", restored: "resolved",
    resolved: "resolved", declined: "declined", unresolved: "unresolved",
  };
  for (const [backend, expected] of Object.entries(statuses)) {
    const result = mapCaseSummary(row({ status: backend }), 7);
    assert.equal(result.status, expected);
    assert.equal(result.health, ["restored", "resolved", "declined"].includes(backend) ? "clear" : "affected");
    assert.equal(result.number, 7);
    assert.equal(result.happenedAt, 1000);
  }
  assert.equal(mapCaseSummary(row({ kind: "bug_report", status: "waiting_for_owner" }), 1).health, "needs_you");
  assert.equal(mapCaseSummary(row({ kind: "feature_request" }), 1).health, "working");
});

test("only passing mergeable PRs mark executing cases ready, and terminal cases remain terminal", () => {
  const ready = pullRequest({ checks: "passing", mergeable: true });
  assert.equal(mapCaseSummary(row({ status: "waiting_for_deploy" }), 1, ready).status, "ready_to_merge");
  for (const request of [pullRequest(), pullRequest({ checks: "failing" }), pullRequest({ checks: "passing", mergeable: false }), pullRequest({ state: "merged" })]) {
    assert.equal(mapCaseSummary(row({ status: "executing" }), 1, request).status, "enacting");
  }
  assert.equal(mapCaseSummary(row({ status: "resolved" }), 1, ready).status, "resolved");
});

test("summary maps real categories, identities and distinct feature requesters without invented stars", () => {
  const summary = mapCaseSummary(row({ kind: "feature_request", reportCount: 10, distinctRequesterCount: 3 }), 4);
  assert.equal(summary.type, "feature");
  assert.equal(summary.category, "feature_request");
  assert.equal(summary.reportCount, 3);
  assert.equal(summary.projectId, "app-1");
  assert.equal("starred" in summary, false);
  assert.equal(mapCaseSummary(row({ kind: "bug_report", reportCount: 0 }), 1).category, "bug");
  assert.equal(mapCaseSummary(row({ reportCount: 0 }), 1).reportCount, 0);
  assert.equal("reportCount" in mapCaseSummary(row({ kind: "feature_request", reportCount: 10 }), 1), false);
});

test("PR mapping preserves the exact live snapshot and strips unrelated data", () => {
  assert.equal(mapPullRequest(null), undefined);
  assert.equal(mapPullRequest(undefined), undefined);
  const original = pullRequest({ privateOutput: "not for display" });
  const result = mapPullRequest(original);
  assert.equal(result.headSha, "abc123");
  assert.equal(result.mergeable, false);
  assert.equal("privateOutput" in result, false);
  assert.notEqual(result.checkRuns, original.checkRuns);
  assert.notEqual(result.checkRuns[0], original.checkRuns[0]);
});

test("core case survives missing optional newer queries and never borrows proposal options", () => {
  const result = map(cards({ proposal: { options: [fix()] } }));
  assert.equal(result.summary, "A test booking could not be saved.");
  assert.deepEqual(result.fixes, []);
  assert.deepEqual(result.code, []);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.screenshots, []);
  assert.equal(result.enactment, undefined);
  assert.match(content(result), /Not covered: no after-action verification/);
  assert.match(content(result), /Source code is not available/);
  const unnumbered = mapCaseDetail(cards(), undefined, undefined, undefined, undefined);
  assert.equal(unnumbered.number, 0);
  assert.match(content(unnumbered), /The display number is not available yet\./);
  assert.doesNotMatch(content(unnumbered), /#0/);
});

test("journey visualization uses only recorded step verdicts, not assumptions about a failed step", () => {
  const result = map(cards({
    journey: { name: "Book", check: { kind: "http", config: { url: "https://app.test/journey-check" } } },
    evidence: [evidence({ body: "load_catalog: passed. Selected a service.\nrecommendations: failed. Provider timed out.\nsubmit_booking: skipped. No write.\nCleanup succeeded (0 test booking(s) deleted)." })],
  }));
  assert.deepEqual(result.overview.find((block) => block.kind === "visualization").viz, {
    type: "journey", steps: [
      { label: "load_catalog", state: "passed" }, { label: "recommendations", state: "failed" },
      { label: "submit_booking (skipped)", state: "not_reached" },
    ],
  });
  const withoutSteps = map(cards({ journey: { name: "Book" }, evidence: [evidence({ body: "No structured step verdicts." })] }));
  assert.equal(withoutSteps.overview.some((block) => block.kind === "visualization"), false);
  assert.match(content(withoutSteps), /Not covered: no step-level journey result/);
});

test("the visualization retains the original failure instead of replacing it with an after-action pass", () => {
  const result = map(cards({ evidence: [
    evidence({ _id: "after", observedAt: 3000, body: "submit_booking: passed. Saved." }),
    evidence({ _id: "before", observedAt: 1200, body: "submit_booking: failed. Not saved." }),
  ] }));
  assert.equal(result.overview.find((block) => block.kind === "visualization").viz.steps[0].state, "failed");
});

test("diagnosis and evidence citations resolve to recorded evidence, while private arbitrary output never renders", () => {
  const result = map(cards({ evidence: [evidence({ body: "Provider did not respond." })], steps: [step({
    currentAttempt: attempt({ output: { diagnosis: {
      source: "rules", cause: "Booking waited for recommendations.", noModelReason: "Unavailable",
      supportingEvidenceIds: ["evidence-1", "missing"],
    }, headers: { Authorization: "private-token" }, source: "invented-source", unrelated: { secret: "private-value" } } }),
  })] }));
  assert.match(content(result), /Rule-based reading, not a model diagnosis/);
  assert.match(content(result), /No model answered: Unavailable/);
  assert.ok(result.citations.some((citation) => citation.id === "evidence-1" && citation.logId === "evidence-1"));
  assert.match(result.logs.find((line) => line.id === "evidence-1").source, /^Evidence/);
  assert.doesNotMatch(JSON.stringify(result), /private-token|private-value|invented-source/);
  for (const block of result.overview.filter((block) => block.kind === "paragraph")) {
    for (const span of block.spans.filter((span) => span.cite)) assert.ok(result.citations.some((citation) => citation.id === span.cite));
  }
});

test("execution history retains retries, original times and failure text rather than repeating the current attempt", () => {
  const failed = attempt({ _id: "first", attempt: 1, status: "failed", summary: undefined, error: "No answer", finishedAt: 1300 });
  const completed = attempt({ _id: "second", attempt: 2, summary: "Reconciled; no duplicate send.", finishedAt: 1700 });
  const result = map(cards({ steps: [step({ purpose: "authorize_and_execute", title: "Execute", currentAttempt: completed })], executeAttempts: [failed, completed] }));
  assert.deepEqual(result.logs.map((line) => [line.id, line.at, line.level]), [["attempt:first", 1300, "error"], ["attempt:second", 1700, "info"]]);
  assert.match(content(result), /attempt 1\): No answer/);
  assert.match(content(result), /attempt 2\): Reconciled/);
});

test("verification keeps before/after scope and labels uncovered criteria explicitly", () => {
  const result = map(cards({ evidence: [evidence()], verifications: [verification({
    criterionResults: [
      { criterionId: "journey", status: "passed", summary: "Saved a booking.", evidenceIds: ["evidence-1"] },
      { criterionId: "device", status: "uncovered", summary: "No device run happened.", evidenceIds: [] },
    ], coverage: { coveredCriterionIds: ["journey"], uncoveredCriterionIds: ["device", "other"] },
  }), verification({ _id: "before", phase: "before", verdict: "failed", completedAt: 1200, summary: "Failed before any change." })] }));
  assert.match(content(result), /Before any change — failed/);
  assert.match(content(result), /After the action — passed/);
  assert.match(content(result), /Not covered — device: No device run happened/);
  assert.match(content(result), /Not covered — other/);
  assert.equal(result.overview.flatMap((block) => block.spans ?? []).some((span) => span.cite === "evidence-1"), true);
});

test("fixes come from their dedicated query, keep recommendation and delivery, and drop dangling code references", () => {
  const result = map(cards({ evidence: [evidence()], proposal: { options: [fix({ title: "Stale proposal" })] } }), {
    chosenKey: null, fixes: [fix({ why: [{ text: "Observed failure", cite: "evidence-1" }, { text: "No source", cite: "missing-code" }], codeIds: ["missing-code"], delivery: "pull_request" })],
  });
  assert.equal(result.fixes[0].title, "Turn off recommendations");
  assert.equal(result.fixes[0].recommended, true);
  assert.equal(result.fixes[0].delivery, "pull_request");
  assert.deepEqual(result.fixes[0].why, [{ text: "Observed failure", cite: "evidence-1" }, { text: "No source" }]);
  assert.equal(result.fixes[0].codeIds, undefined);
  assert.deepEqual(result.code, []);
});

test("screenshots preserve actual URL, time, caption and phase without manufacturing evidence", () => {
  const shots = [{ id: "shot-1", url: "https://storage.test/shot", caption: "Booking check after action", phase: "after", takenAt: 2000 }];
  const result = map(cards(), undefined, undefined, shots);
  assert.deepEqual(result.screenshots, shots);
  assert.notEqual(result.screenshots[0], shots[0]);
  assert.equal(result.overview.some((block) => JSON.stringify(block).includes("verified repair")), false);
});

test("staged fixtures and the known booking-demo route remain explicitly labelled", () => {
  for (const sample of [
    cards({ case: row({ isSample: true }) }),
    cards({ steps: [step({ staged: { fail: 1 } })] }),
    cards({ journey: { check: { kind: "http", config: { url: "https://app.test/booking-demo/journey-check" } } } }),
    cards({ steps: [step({ currentAttempt: attempt({ summary: "Staged fixture; not an actual protected-app run." }) })] }),
  ]) assert.match(content(map(sample)), /came from a staged practice failure on the demo app/);
});

test("enactment uses the approved action and actual workflow statuses, not a synthetic repair plan", () => {
  const result = map(cards({ action: action({ status: "running" }), case: row({ status: "executing" }), steps: [
    step(), step({ key: "execute", purpose: "authorize_and_execute", status: "waiting", currentAttempt: attempt({ summary: "Waiting for the PR." }) }),
    step({ key: "verify", purpose: "verify", status: "pending", currentAttempt: null }),
  ] }));
  assert.equal(result.enactment.fixKey, "recover");
  assert.equal(result.enactment.state, "running");
  assert.deepEqual(result.enactment.steps.map((item) => [item.key, item.status]), [["execute", "pending"], ["verify", "pending"]]);
  assert.match(result.enactment.steps[0].detail, /Waiting/);
  assert.equal(result.enactment.steps[0].estimatedDurationMs, undefined);
});

test("PR states never imply live recovery, and merge requires passing checks plus mergeability", () => {
  const value = cards({ action: action({ status: "running" }), case: row({ status: "waiting_for_deploy" }) });
  for (const [pr, state] of [
    [pullRequest(), "running"], [pullRequest({ checks: "passing", mergeable: true }), "waiting_for_merge"],
    [pullRequest({ checks: "failing" }), "needs_you"], [pullRequest({ checks: "none" }), "needs_you"],
    [pullRequest({ checks: "passing" }), "needs_you"], [pullRequest({ state: "merged" }), "merged"],
    [pullRequest({ state: "closed" }), "failed"],
  ]) assert.equal(map(value, undefined, pr).enactment.state, state);
});

test("done requires current-action verification, and placeholders or an older pass cannot prove recovery", () => {
  const resolved = cards({ case: row({ status: "restored" }), action: action(), steps: [step({ purpose: "verify", summary: "done" })] });
  assert.equal(map(resolved).enactment.state, "needs_you");
  assert.match(map(resolved).enactment.question.text, /Not covered/);
  assert.equal(map({ ...resolved, verifications: [verification()] }).enactment.state, "done");
  for (const results of [
    [verification({ actionId: "old-action" })], [verification({ summary: "Staged passing fixture, not live evidence." })],
    [verification(), verification({ _id: "new-failure", completedAt: 1800, verdict: "failed" })],
    [verification({ criterionResults: [], coverage: { coveredCriterionIds: [], uncoveredCriterionIds: ["journey"] } })],
  ]) assert.notEqual(map({ ...resolved, verifications: results }).enactment.state, "done");
  assert.equal(map(cards({ action: action({ status: "unknown" }) })).enactment.state, "needs_you");
  assert.equal(map(cards({ action: action({ status: "cancelled" }) })).enactment.state, "stopped");
  assert.equal(map(cards({ action: action({ status: "failed" }) })).enactment.state, "failed");
});

test("action output is shown without exposing its frozen private execution payload", () => {
  const result = map(cards({ action: action({ result: "The application confirmed the flag is off.", completedAt: 1800, executionPayload: { config: { credentialRef: "secret-reference", token: "private-token" } } }) }));
  assert.match(content(result), /Change an app setting \(completed\): The application confirmed/);
  assert.equal(result.logs.find((line) => line.id === "action:action-1").at, 1800);
  assert.doesNotMatch(JSON.stringify(result), /secret-reference|private-token/);
});

test("learned prefers the recorded memory and otherwise labels learn output as a case note, not recovery proof", () => {
  const learning = step({ purpose: "learn", currentAttempt: attempt({ summary: "No recovery memory was saved.", output: { note: "The run did not verify a recovery." } }) });
  const result = map(cards({ learnedMemory: {
    cause: "The optional provider blocked booking.", conditions: ["Recommendations are on."],
    notWhen: ["Booking storage is unavailable."], timesVerified: 2,
  }, steps: [learning] }));
  assert.match(result.learned, /Cause: The optional provider blocked booking\./);
  assert.match(result.learned, /Conditions: Recommendations are on\./);
  assert.match(result.learned, /Do not use when: Booking storage is unavailable\./);
  assert.match(result.learned, /Recorded verified recoveries: 2\./);
  assert.doesNotMatch(result.learned, /The run did not verify/);
  assert.equal(map(cards({ steps: [learning] })).learned, "Case-note text (not proof of recovery): The run did not verify a recovery.");
  assert.equal(map(cards({ steps: [step({ purpose: "learn", currentAttempt: attempt({ output: { summary: "No verified recovery to remember." } }) })] })).learned, "Case-note text (not proof of recovery): No verified recovery to remember.");
  assert.equal(map(cards({ steps: [step({ purpose: "learn", currentAttempt: attempt({ summary: "No check ran." }) })] })).learned, "Case-note text (not proof of recovery): No check ran.");
  assert.equal(map(cards()).learned, undefined);
});

test("automatic recovery shows its recorded scoped permission use without inventing provenance", () => {
  const automatic = {
    case: row({ status: "restored" }),
    action: action({ requestedBy: "auto", permissionId: "permission-1" }),
    runPermission: { _id: "permission-1", use: 1, maxAttempts: 3 },
  };
  assert.match(content(map(cards(automatic))), /turtl handled this case under your scoped permission \(use 1 of 3\)/);
  const pending = { ...automatic, case: row({ status: "executing" }), action: action({ requestedBy: "auto", permissionId: "permission-1", status: "pending" }) };
  assert.match(content(map(cards(pending))), /This action is recorded under your scoped permission/);
  assert.doesNotMatch(content(map(cards(pending))), /turtl handled this case/);
  for (const fields of [
    { runPermission: null },
    { runPermission: { ...automatic.runPermission, _id: "different-permission" } },
    { action: action({ requestedBy: "owner" }) },
  ]) assert.doesNotMatch(content(map(cards({ ...automatic, ...fields }))), /under your scoped permission/);
  for (const use of [0, -1, 4]) {
    const result = content(map(cards({ ...automatic, runPermission: { ...automatic.runPermission, use } })));
    assert.match(result, /usage count not available/);
    assert.doesNotMatch(result, /use \d of/);
  }
});

test("raw step ids, evidence kinds and action types reach the owner as plain names", () => {
  const collect = step({ _id: "step-collect", key: "collect_app_state", purpose: "collect_app_state", title: "Read app health, flags and revision",
    currentAttempt: attempt({ _id: "attempt-collect", summary: "Read the app's health.", handoff: "Sample handoff from collect_app_state." }) });
  const gather = step({ _id: "step-gather", key: "gather_context", purpose: "gather_context", title: "Gather context", dependsOn: ["collect_app_state"],
    currentAttempt: attempt({ _id: "attempt-gather", summary: "Joined what collect_app_state found." }) });
  const result = map(cards({
    steps: [collect, gather], evidence: [evidence()],
    action: action({ result: "The flag is off." }),
    verifications: [verification({ criterionResults: [{ criterionId: "booking_saved", status: "passed", summary: "A test booking was saved.", evidenceIds: [] }] })],
    agentRuns: [{ _id: "run-1", _creationTime: 1300, status: "completed", taskType: "propose_fixes", config: { modelId: "gpt-test" } }],
  }));
  const everything = content(result) + "\n" + result.logs.map((line) => line.source + "\n" + line.text).join("\n");
  assert.doesNotMatch(everything, /collect_app_state|gather_context|journey_check|set_feature_flag|propose_fixes|booking_saved|protected-app/);
  assert.match(everything, /Sample handoff from “Read app health, flags and revision”\./);
  assert.match(everything, /Joined what “Read app health, flags and revision” found\./);
  assert.match(everything, /Evidence · Journey check/);
  assert.match(everything, /Action · Change an app setting/);
  assert.match(everything, /Agent run · fix ideas/);
  assert.match(everything, /Passed — booking saved: A test booking was saved\./);
});

test("a missing model key reads as no model connected, and customer cases are marked for the Approve sheet", () => {
  const diagnosing = step({ currentAttempt: attempt({ output: { diagnosis: { source: "rules", cause: "Booking waited.", noModelReason: "OPENAI_API_KEY is not set on this deployment, so no model was asked" } } }) });
  assert.match(content(map(cards({ steps: [diagnosing] }))), /No model answered: turtl has no model connected yet/);
  assert.equal(map(cards({ case: row({ raisedBy: "customer" }) })).raisedByCustomers, true);
  assert.equal("raisedByCustomers" in map(cards()), false);
});

test("Logs say where evidence came from in plain words, with no ids, and show a gather step's copy once", () => {
  const original = evidence({ _id: "ms76original", stepAttemptId: "r177attempt", kind: "health", title: "The booking app reports health ok is true.", sourceRef: "GET /health" });
  const copy = evidence({ _id: "ms76copy", stepAttemptId: "gather-1", kind: "health", title: original.title, sourceRef: "Copied from an earlier step: GET /health", copyOf: "ms76original" });
  const legacy = evidence({ _id: "ms76legacy", stepAttemptId: "gather-0", kind: "health", title: original.title, sourceRef: "Derived from evidence/ms76original; stepAttempts/r177attempt; GET /health" });
  const detail = map(cards({ evidence: [original, copy, legacy] }));
  const lines = detail.logs.filter((log) => log.source.startsWith("Evidence"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "The booking app says it is healthy.\nFrom the app's health check.");
  const all = detail.logs.map((log) => log.source + "\n" + log.text).join("\n") + content(detail);
  for (const raw of ["ms76", "r177", "stepAttempts", "Derived from", "GET /", "health ok"]) assert.ok(!all.includes(raw), raw);
  assert.equal(content(detail).split("\n").filter((line) => line === "The booking app says it is healthy.").length, 1);
  // A citation of either copy opens the original's line.
  for (const id of ["ms76copy", "ms76legacy"]) assert.deepEqual(detail.citations.find((c) => c.id === id), { id, kind: "log", logId: "ms76original" });
});

test("a copy whose original is not on the case is still shown, and unknown sources with ids are left out", () => {
  const copy = evidence({ _id: "e-copy", sourceRef: "Copied from an earlier step: POST /journey-check (v1)", copyOf: "gone" });
  const odd = evidence({ _id: "e-odd", title: "Something odd.", sourceRef: "widgets/k57abcdefghijklmnopq" });
  const texts = map(cards({ evidence: [copy, odd] })).logs.map((log) => log.text);
  assert.ok(texts.includes("The check failed.\nFrom turtl's check of the journey."));
  assert.ok(texts.includes("Something odd."));
});

test("an error code in brackets is not shown to the owner", () => {
  const check = evidence({ title: 'The booking check failed at the "recommendations" step (RECOMMENDATIONS_TIMEOUT), so no booking was saved.' });
  const done = step({ currentAttempt: attempt({ summary: 'Reproduced before any change: The booking check failed at the "recommendations" step (RECOMMENDATIONS_TIMEOUT), so no booking was saved.' }) });
  const detail = map(cards({ evidence: [check], steps: [done] }));
  assert.ok(!JSON.stringify(detail).includes("RECOMMENDATIONS_TIMEOUT"));
  assert.ok(content(detail).includes('failed at the "recommendations" step, so no booking was saved.'));
});
