import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { repair, REQUIRED_CRITERIA, fixture, passingResult, snapshot, HEAD, MERGE, CONDITIONS, githubResponses } from "./external-app-test-harness.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN; delete globalThis.externalAppProbeMocks; });

test("candidate testing requires the named regression job and is not deployment or gameplay", () => {
  assert.equal(repair.candidateFact(snapshot(), "gameplay-regression", "passed", 1).status, "passed");
  assert.equal(repair.candidateFact(snapshot(), undefined, "missing", 1).status, "not_tested");
  assert.equal(repair.candidateFact(snapshot(), "gameplay-regression", "missing", 1).status, "not_tested");
  assert.equal(repair.candidateFact(snapshot(), "gameplay-regression", "pending", 1).status, "pending");
  assert.equal(repair.candidateFact(snapshot(), "gameplay-regression", "failed", 1).status, "failed");
});

test("only six passing criteria and comparable real answer evidence pass gameplay", () => {
  const run = { outcome: "passed", result: passingResult(), expectedRevision: MERGE, revisionBefore: MERGE, revisionAfter: MERGE };
  const assessment = repair.assessGameplay(run, CONDITIONS, MERGE, "demo");
  assert.equal(assessment.verdict, "passed");
  assert.deepEqual(assessment.criteria.map((criterion) => criterion.criterionId), REQUIRED_CRITERIA);
  for (const mutate of [
    (value) => value.result.fixture.scoreCount--,
    (value) => { value.result.fixture.id = "small-v1"; },
    (value) => value.result.deadlineMs++,
    (value) => value.result.viewport.width--,
    (value) => { value.result.revision = HEAD; },
    (value) => { value.revisionAfter = HEAD; },
    (value) => { value.result.environment = "preview"; },
    (value) => { value.result.steps = []; },
    (value) => { value.result.steps = value.result.steps.slice(0, 1); },
    (value) => { value.result.steps.forEach((step) => { step.request.durationMs = CONDITIONS.deadlineMs + 1; }); },
    (value) => value.result.criteria.pop(),
    (value) => { value.result.criteria[1].id = value.result.criteria[0].id; },
    (value) => { value.result.cleanup.ok = false; },
    (value) => { value.outcome = "inconclusive"; },
  ]) {
    const changed = structuredClone(run);
    mutate(changed);
    assert.equal(repair.assessGameplay(changed, CONDITIONS, MERGE, "demo").verdict, "inconclusive", mutate.toString());
  }
  const failed = structuredClone(run);
  failed.result.criteria[0].status = "failed";
  failed.result.verdict = "failed";
  failed.outcome = "failed";
  assert.equal(repair.assessGameplay(failed, CONDITIONS, MERGE, "demo").verdict, "failed");
  assert.equal(repair.assessGameplay(run, null, MERGE, "demo").verdict, "inconclusive");
});

test("begin waits only after GitHub confirms a real merged PR and freezes candidate facts", async () => {
  const f = fixture();
  process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN = "mock-only";
  globalThis.fetch = githubResponses();
  const result = await repair.beginVerification(f.ctx, { case: { _id: "case1" }, attempt: { _id: "attempt1" } });
  assert.equal(result.status, "waiting");
  assert.equal(result.caseStatus, "waiting_for_deploy");
  assert.deepEqual(f.held, [{ attemptId: "attempt1" }]);
  const proof = f.tableRows("repairProofs")[0];
  assert.equal(proof.candidate.status, "passed");
  assert.equal(proof.candidate.headSha, HEAD);
  assert.equal(proof.deployment.expectedSha, MERGE);
  assert.equal(proof.deployment.status, "waiting");
  assert.equal(proof.gameplay.status, "not_run");
  assert.equal(f.tableRows("verifications").length, 0);
  assert.equal(f.scheduled[0].name, "externalApp/repair:checkDeployment");
  await repair.beginVerification(f.ctx, { case: { _id: "case1" }, attempt: { _id: "attempt1" } });
  assert.equal(f.tableRows("repairProofs").length, 1);
  assert.equal(f.scheduled.length, 1);
});

test("an unavailable or unmerged PR never becomes fabricated merge evidence", async () => {
  for (const config of [{ merged: false }, { mergeSha: null }]) {
    const f = fixture();
    process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN = "mock-only";
    globalThis.fetch = githubResponses(config);
    const result = await repair.beginVerification(f.ctx, { case: { _id: "case1" }, attempt: { _id: "attempt1" } });
    assert.equal(result.status, "failed");
    assert.equal(f.tableRows("repairProofs").length, 0);
    assert.equal(f.scheduled.length, 0);
  }
  const f = fixture();
  delete process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN;
  assert.equal((await repair.beginVerification(f.ctx, { case: { _id: "case1" }, attempt: { _id: "attempt1" } })).status, "failed");
  assert.equal(f.tableRows("repairProofs").length, 0);
});

test("a skipped regression check is not a tested candidate even if aggregate checks pass", async () => {
  const f = fixture();
  process.env.EXTERNAL_APP_TEST_GITHUB_TOKEN = "mock-only";
  globalThis.fetch = githubResponses({ conclusion: "skipped" });
  await repair.beginVerification(f.ctx, { case: { _id: "case1" }, attempt: { _id: "attempt1" } });
  assert.notEqual(f.tableRows("repairProofs")[0].candidate.status, "passed");
});

test("revision gate reschedules mismatches instead of sleeping or dispatching a probe", async () => {
  const f = fixture();
  f.addProof();
  let probes = 0;
  globalThis.externalAppProbeMocks = {
    readRevision: async () => ({ ok: true, body: { revision: HEAD, environment: "demo" } }),
    startProbe: async () => { probes++; },
  };
  await repair.checkDeployment._handler(f.ctx, { proofId: "proof1" });
  assert.equal(probes, 0);
  assert.equal(f.rows.get("proof1").deployment.status, "waiting");
  assert.equal(f.rows.get("proof1").deployment.observedSha, HEAD);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].delay, 10_000);
  globalThis.externalAppProbeMocks.readRevision = async () => ({ ok: true, body: { revision: MERGE, environment: "preview" } });
  await repair.checkDeployment._handler(f.ctx, { proofId: "proof1" });
  assert.equal(probes, 0);
  assert.equal(f.rows.get("proof1").deployment.status, "waiting");
});

test("deployment timeout records inconclusive evidence, never a gameplay pass", async () => {
  const f = fixture();
  f.addProof({ deployment: { status: "waiting", expectedSha: MERGE, environment: "demo", waitingSince: Date.now() - 6 * 60_000 } });
  await repair.observeDeployment._handler(f.ctx, { proofId: "proof1", revision: HEAD, environment: "demo" });
  assert.equal(f.rows.get("proof1").deployment.status, "not_confirmed");
  assert.equal(f.rows.get("proof1").gameplay.status, "inconclusive");
  const verification = f.tableRows("verifications")[0];
  assert.equal(verification.verdict, "inconclusive");
  assert.equal(verification.criterionResults.length, 6);
  assert.ok(verification.criterionResults.every((criterion) => criterion.status === "uncovered"));
  assert.equal(f.scheduled.at(-1).args.result.status, "failed");
  assert.equal(f.scheduled.at(-1).args.result.caseStatus, undefined);
});

test("exact deployed merge starts a bound probe but is not itself gameplay verification", async () => {
  const f = fixture();
  f.addProof();
  let dispatched;
  globalThis.externalAppProbeMocks = {
    readRevision: async () => ({ ok: true, body: { revision: MERGE, environment: "demo" } }),
    startProbe: async (_ctx, args) => {
      dispatched = args;
      return f.addProbe({ outcome: undefined, completedAt: undefined });
    },
  };
  await repair.checkDeployment._handler(f.ctx, { proofId: "proof1" });
  assert.equal(f.rows.get("proof1").deployment.status, "confirmed");
  assert.equal(f.rows.get("proof1").gameplay.status, "running");
  assert.equal(dispatched.expectedRevision, MERGE);
  assert.deepEqual(dispatched.baseline, CONDITIONS);
  assert.equal(dispatched.caseId, "case1");
  assert.equal(dispatched.stepAttemptId, "attempt1");
  assert.equal(f.tableRows("verifications").length, 0);
});

test("completion binds evidence to the PR/case/attempt and restores only after all facts pass", async () => {
  const f = fixture();
  f.addProof({ deployment: { status: "confirmed", expectedSha: MERGE, observedSha: MERGE, environment: "demo", waitingSince: 1000 } });
  f.addProbe();
  await repair.completeVerification(f.ctx, "after1");
  const verification = f.tableRows("verifications")[0];
  assert.equal(verification.phase, "after_deploy");
  assert.equal(verification.verdict, "passed");
  assert.equal(verification.actionId, "action1");
  assert.equal(verification.stepAttemptId, "attempt1");
  assert.equal(verification.revision.commitSha, MERGE);
  const evidence = f.tableRows("evidence")[0];
  assert.equal(evidence.caseId, "case1");
  assert.equal(JSON.parse(evidence.body).pullRequestId, "pull1");
  assert.equal(JSON.parse(evidence.body).baselineProbeRunId, "before1");
  assert.equal(f.scheduled.at(-1).args.result.caseStatus, "restored");
  await repair.completeVerification(f.ctx, "after1");
  assert.equal(f.tableRows("verifications").length, 1);
  assert.equal(f.scheduled.length, 1);
});

test("a smaller fixture and a changed deadline preserve evidence but leave the repair unresolved", async () => {
  for (const change of [(result) => result.fixture.scoreCount--, (result) => result.deadlineMs++]) {
    const f = fixture();
    f.addProof({ deployment: { status: "confirmed", expectedSha: MERGE, environment: "demo", waitingSince: 1000 } });
    const result = passingResult();
    change(result);
    f.addProbe({ result });
    await repair.completeVerification(f.ctx, "after1");
    assert.equal(f.tableRows("verifications")[0].verdict, "inconclusive");
    assert.equal(f.scheduled.at(-1).args.result.status, "failed");
    assert.equal(f.scheduled.at(-1).args.result.caseStatus, undefined);
    assert.ok(JSON.parse(f.tableRows("evidence")[0].body).result);
  }
});

test("gameplay may pass while candidate testing remains failed, without restoring", async () => {
  const f = fixture();
  f.addProof({ candidate: repair.candidateFact(snapshot(), "gameplay-regression", "failed", 1),
    deployment: { status: "confirmed", expectedSha: MERGE, environment: "demo", waitingSince: 1000 } });
  f.addProbe();
  await repair.completeVerification(f.ctx, "after1");
  assert.equal(f.rows.get("proof1").gameplay.status, "passed");
  assert.equal(f.rows.get("proof1").candidate.status, "failed");
  assert.equal(f.scheduled.at(-1).args.result.status, "failed");
});

test("callbacks for a stale attempt or a different app never restore the current case", async () => {
  for (const change of [(f) => { f.rows.get("verify1").currentAttemptId = "attempt2"; }, (f) => { f.rows.get("after1").externalAppId = "other-app"; }]) {
    const f = fixture();
    f.addProof({ deployment: { status: "confirmed", expectedSha: MERGE, environment: "demo", waitingSince: 1000 } });
    f.addProbe();
    change(f);
    await repair.completeVerification(f.ctx, "after1");
    assert.equal(f.tableRows("verifications").length, 0);
    assert.equal(f.scheduled.length, 0);
  }
});
