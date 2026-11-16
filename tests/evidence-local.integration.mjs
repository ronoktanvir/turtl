import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { evidenceServer } from "./fixtures/evidence-http.mjs";

const config = JSON.parse(readFileSync(new URL("../.convex/local/default/config.json", import.meta.url), "utf8"));
const url = `http://127.0.0.1:${config.ports.cloud}`;
const client = new ConvexHttpClient(url);
client.setAdminAuth(config.adminKey);
const ref = makeFunctionReference;
const mutation = (name, args) => client.mutation(ref(name), args);
const query = (name, args) => client.query(ref(name), args);
const snapshot = (caseId) => query("evidence/localProof:snapshot", { caseId });
const step = (data, key) => data.steps.find((row) => row.key === key);
const attempts = (data, key) => data.attempts.filter((row) => row.stepId === step(data, key)._id);
const acceptedFields = (attempt) => {
  const { lateResult, lateResultAt, ...accepted } = attempt;
  return accepted;
};
const records = [];
async function until(caseId, predicate, label, timeout = 35_000) {
  const deadline = Date.now() + timeout;
  let data;
  while (Date.now() < deadline) {
    data = await snapshot(caseId);
    if (predicate(data)) return data;
    await delay(200);
  }
  throw new Error(`${label}: ${JSON.stringify(data?.steps.map((row) => ({ key: row.key, status: row.status, error: row.currentAttempt?.error })))}`);
}

test("real local Convex evidence fork/join", { timeout: 240_000 }, async (t) => {
  const server = await evidenceServer();
  t.after(() => server.close());
  const seed = async (scenario, mode = "parallel", paused = false) => {
    const created = await mutation("evidence/localProof:seed", { base: scenario.base, label: scenario.name, mode, paused });
    records.push({ name: scenario.name, ...created });
    return created.caseId;
  };
  const ready = (caseId) => until(caseId, (data) => data.case.status === "waiting_for_owner", "approval was not reached");

  await t.test("two independent HTTP collectors overlap, gate the join and retain exact provenance", async () => {
    const source = server.add("overlap", { holdFlags: true, holdErrors: true });
    const caseId = await seed(source);
    const running = await until(caseId, (data) => ["collect_app_state", "collect_error_window"].every((key) => step(data, key).status === "running"), "collectors did not overlap");
    assert.equal(step(running, "gather_context").status, "pending");
    assert.equal(attempts(running, "gather_context").length, 0);
    assert.equal(running.actions.length, 0);
    await delay(250);
    assert.ok(source.events.some((event) => event.resource === "flags" && !event.finishedAt));
    assert.ok(source.events.some((event) => event.resource === "errors" && !event.finishedAt));
    source.flagsGate.release();
    const oneDone = await until(caseId, (data) => step(data, "collect_app_state").status === "done", "app-state did not finish independently");
    assert.equal(step(oneDone, "gather_context").status, "pending");
    assert.equal(attempts(oneDone, "gather_context").length, 0);
    source.release();
    const data = await ready(caseId);
    const state = step(data, "collect_app_state").currentAttempt;
    const errors = step(data, "collect_error_window").currentAttempt;
    const join = step(data, "gather_context").currentAttempt;
    assert.notEqual(state._id, errors._id);
    assert.ok(Math.max(state.startedAt, errors.startedAt) < Math.min(state.finishedAt, errors.finishedAt));
    assert.deepEqual(new Set(join.inputRefs), new Set([state._id, errors._id]));
    assert.equal(state.output.collector, "collect_app_state");
    assert.equal(errors.output.collector, "collect_error_window");
    assert.equal(join.output.facts["health.ok"], true);
    assert.equal(join.output.facts["flags.recommendationsEnabled"], true);
    assert.equal(join.output.facts["errors.failedBookings"], 3);
    assert.ok(join.output.recall);
    assert.equal(source.errorReads, 1, "the join reread /errors");
    assert.equal(source.events.filter((event) => event.resource === "flags").length, 1, "the join reread /flags");
    assert.equal(data.actions.length, 0);
    for (const parent of [state, errors]) {
      for (const provenance of parent.output.evidence) {
        const original = data.evidence.find((row) => row._id === provenance.id);
        assert.equal(original.stepAttemptId, parent._id);
        assert.equal(original.caseId, caseId);
        assert.deepEqual(original.revision, provenance.revision);
        assert.equal(original.observedAt, provenance.observedAt);
        const projection = data.evidence.find((row) => row.stepAttemptId === join._id && row.sourceRef?.includes(`evidence/${original._id}`));
        assert.ok(projection, "existing gather-attempt filters lost collector evidence");
        assert.ok(projection.sourceRef.includes(`stepAttempts/${parent._id}`));
        assert.equal(projection.observedAt, original.observedAt);
        assert.deepEqual(projection.revision, original.revision);
        assert.equal(projection.environment, original.environment);
        assert.ok(join.outputRefs.some((item) => item.id === original._id));
      }
    }
    const projectionRefs = await Promise.all([
      mutation("evidence/records:projectEvidence", { attemptId: join._id }),
      mutation("evidence/records:projectEvidence", { attemptId: join._id }),
    ]);
    assert.deepEqual(projectionRefs[0], projectionRefs[1]);
    assert.equal((await snapshot(caseId)).evidence.length, data.evidence.length, "duplicate projection calls inflated evidence");
    await assert.rejects(mutation("evidence/records:projectEvidence", { attemptId: state._id }), /gather|collector/i);
    records.at(-1).overlap = { state: [state.startedAt, state.finishedAt], errors: [errors.startedAt, errors.finishedAt], inputRefs: join.inputRefs };
  });

  await t.test("one required collector retries alone and late callbacks cannot change consumed facts", async () => {
    const source = server.add("retry", { failErrors: 1 });
    const caseId = await seed(source);
    const before = await ready(caseId);
    assert.equal(attempts(before, "collect_app_state").length, 1);
    const errorAttempts = attempts(before, "collect_error_window");
    assert.equal(errorAttempts.length, 2);
    assert.equal(errorAttempts[0].status, "failed");
    assert.equal(errorAttempts[1].status, "done");
    const join = step(before, "gather_context").currentAttempt;
    assert.ok(join.inputRefs.includes(errorAttempts[1]._id));
    assert.ok(!join.inputRefs.includes(errorAttempts[0]._id));
    for (const target of [errorAttempts[0], errorAttempts[1], join]) {
      const result = await mutation("runner/run:recordResult", {
        attemptId: target._id,
        result: { status: "done", summary: "Explicit local late-result test", output: { facts: { "health.ok": false, "errors.failedBookings": 999 } } },
      });
      assert.equal(result.applied, false);
    }
    await mutation("runner/run:recordResult", { attemptId: errorAttempts[1]._id, result: { status: "failed", error: "Explicit late failure after success" } });
    const after = await snapshot(caseId);
    for (const old of before.attempts) {
      assert.deepEqual(acceptedFields(after.attempts.find((row) => row._id === old._id)), acceptedFields(old));
    }
    assert.equal(step(after, "collect_error_window").currentAttempt.lateResult.error, "Explicit late failure after success");
    assert.deepEqual(step(after, "gather_context").currentAttempt.output.facts, join.output.facts);
    assert.equal(after.actions.length, 0);
  });

  await t.test("a real late HTTP response after timeout cannot replace the successful retry", async () => {
    const source = server.add("timeout", { holdFirstError: true, lateFirst: true });
    const caseId = await seed(source);
    const first = await until(caseId, (data) => step(data, "collect_error_window").status === "running" && source.errorReads === 1, "held collector did not start");
    const expired = step(first, "collect_error_window").currentAttempt;
    await mutation("runner/run:checkTimeout", { attemptId: expired._id, limitMs: 1 });
    const before = await ready(caseId);
    const current = step(before, "collect_error_window").currentAttempt;
    assert.notEqual(current._id, expired._id);
    assert.equal(current.attempt, 2);
    assert.equal(step(before, "gather_context").currentAttempt.output.facts["errors.failedBookings"], 3);
    source.firstErrorsGate.release();
    const after = await until(caseId, (data) => !!data.attempts.find((row) => row._id === expired._id)?.lateResultAt, "late HTTP result was not recorded");
    const late = after.attempts.find((row) => row._id === expired._id);
    assert.equal(late.status, "failed");
    assert.equal(late.output, undefined);
    assert.equal(late.lateResult.output.facts["errors.failedBookings"], 9);
    assert.deepEqual(acceptedFields(step(after, "collect_error_window").currentAttempt), acceptedFields(current));
    assert.equal(step(after, "gather_context").currentAttempt.output.facts["errors.failedBookings"], 3);
    assert.equal(attempts(after, "collect_app_state").length, 1);
  });

  await t.test("exhausted or malformed required reads do not fabricate success", async () => {
    for (const [name, options, failedKey] of [
      ["exhausted", { failErrors: 3 }, "collect_error_window"],
      ["malformed-errors", { malformedErrors: true }, "collect_error_window"],
      ["missing-flag", { missingFlag: true }, "collect_app_state"],
    ]) {
      const source = server.add(name, options);
      const caseId = await seed(source);
      const data = await until(caseId, (row) => row.case.status === "unresolved", "required failure did not stop the case");
      assert.equal(attempts(data, failedKey).length, 3);
      assert.equal(step(data, "gather_context").status, "pending");
      assert.equal(attempts(data, "gather_context").length, 0);
      assert.equal(data.actions.length, 0);
      assert.equal(data.memories.length, 0);
      assert.equal(data.proposals.length, 0);
      assert.ok(data.evidence.some((row) => row.stepId === step(data, failedKey)._id));
    }
  });

  await t.test("required skipped collectors fail closed even though generic dependencies allow skips", async () => {
    const source = server.add("skipped");
    const caseId = await seed(source, "parallel", true);
    const initial = await snapshot(caseId);
    await mutation("workflow:skip", { stepId: step(initial, "collect_error_window")._id, reason: "Explicit local malformed-template test" });
    await mutation("runner/run:advance", { caseId });
    const data = await until(caseId, (row) => row.case.status === "unresolved", "join accepted skipped required evidence");
    assert.equal(step(data, "gather_context").status, "failed");
    assert.equal(step(data, "investigate").status, "pending");
    assert.equal(data.actions.length, 0);
  });

  await t.test("backend completes the evidence phase after the subscribed client disconnects", async () => {
    const source = server.add("disconnected", { holdFlags: true, holdErrors: true });
    const caseId = await seed(source);
    const subscription = new ConvexClient(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Client did not observe the running fork")), 15_000);
      subscription.onUpdate(ref("cases:get"), { id: caseId }, (data) => {
        if (data.steps.filter((row) => row.status === "running").length >= 2) { clearTimeout(timer); resolve(); }
      }, reject);
    });
    await subscription.close();
    source.release();
    await delay(12_000);
    const data = await snapshot(caseId);
    assert.equal(data.case.status, "waiting_for_owner");
    assert.equal(step(data, "plan").status, "done");
    assert.equal(data.actions.length, 0);
    assert.ok(data.notices.every((row) => row.outcome !== "ran" && row.outcome !== "queued"));
    const proposal = data.proposals.at(-1);
    await assert.rejects(mutation("decisions:approve", { proposalId: proposal._id, version: proposal.version + 1, optionKey: "turn_off_recommendations" }), /version|date/i);
    await assert.rejects(mutation("workflow:skip", { stepId: step(data, "verify")._id, reason: "Explicit local verification guard test" }), /declined/);
    assert.equal((await snapshot(caseId)).actions.length, 0);
    await mutation("decisions:approve", { proposalId: proposal._id, version: proposal.version, optionKey: "turn_off_recommendations" });
    await delay(7_000);
    const finished = await snapshot(caseId);
    assert.equal(finished.actions.length, 1);
    assert.equal(finished.actions[0].requestedBy, "owner");
    assert.equal(step(finished, "verify").status, "done");
    assert.equal(step(finished, "learn").status, "done");
    assert.equal(finished.case.status, "restored");
    const verification = finished.verifications.find((row) => row.phase === "after_fix");
    assert.ok(verification.criterionResults.some((row) => row.criterionId === "booking_journey_passes" && row.status === "passed"));
    assert.ok(verification.criterionResults.some((row) => row.criterionId === "booking_screen_on_device" && row.status === "uncovered"));
    assert.equal(finished.memories.length, 0, "uncovered required device proof must not become verified recovery memory");
    assert.equal(source.events.filter((event) => event.resource === "flags" && event.method === "POST").length, 1);
    records.at(-1).disconnected = { beforeApproval: data.case.status, afterApproval: finished.case.status, verificationCoverage: verification.coverage };
  });

  await t.test("legacy in-flight and sample/no-journey templates keep their eight original steps", async () => {
    for (const mode of ["legacy", "sample", "no_journey"]) {
      const source = server.add(`compat-${mode}`);
      const caseId = await seed(source, mode);
      const data = await ready(caseId);
      assert.equal(data.steps.length, 8);
      assert.equal(data.steps.some((row) => row.purpose.startsWith("collect_")), false);
      assert.deepEqual(data.steps.map((row) => row.key), ["detect_or_receive", "gather_context", "investigate", "examine_broader_causes", "plan", "authorize_and_execute", "verify", "learn"]);
      if (mode !== "no_journey") {
        assert.equal(step(data, "gather_context").currentAttempt.output.facts["health.ok"], true);
        assert.equal(source.errorReads, 1);
      } else {
        assert.equal(source.events.length, 0);
        assert.match(step(data, "gather_context").currentAttempt.summary, /Placeholder/);
        await mutation("runner/run:approve", { caseId });
        const done = await until(caseId, (row) => row.case.status === "resolved", "legacy placeholder runner did not finish");
        assert.ok(done.steps.every((row) => row.status === "done"));
      }
    }
  });

  await t.test("existing memory safety proof still passes on the local backend", async () => {
    const result = await client.action(ref("memory/dev:prove"), {});
    assert.equal(result.invalidFactsFailClosed, true);
    assert.equal(result.lateRecallRejected, true);
    assert.equal(result.foreignAppIgnored, true);
  });

  await t.test("scoped permission still requires two verified recoveries and never itself executes", async () => {
    const first = await mutation("memory/dev:seed", { outcome: "verified" });
    const learned = await client.action(ref("memory/service:learn"), { caseId: first.caseId });
    assert.equal(learned.timesVerified, 1);
    await assert.rejects(mutation("permissions:grant", { memoryId: learned.memoryId }), /at least 2/);
    const second = await mutation("memory/dev:seed", { appId: first.appId, outcome: "verified" });
    const updated = await client.action(ref("memory/service:learn"), { caseId: second.caseId });
    assert.equal(updated.timesVerified, 2);
    const before = await snapshot(second.caseId);
    const permissionId = await mutation("permissions:grant", { memoryId: updated.memoryId });
    await assert.rejects(mutation("permissions:grant", { memoryId: updated.memoryId }), /already has an active permission/);
    assert.deepEqual((await snapshot(second.caseId)).actions, before.actions);
    await mutation("permissions:revoke", { permissionId });
    await mutation("memory/dev:invalidate", { memoryId: updated.memoryId });
    await assert.rejects(mutation("permissions:grant", { memoryId: updated.memoryId }), /invalidated/);
  });

  if (process.env.EVIDENCE_PROOF_OUTPUT) {
    mkdirSync(process.env.EVIDENCE_PROOF_OUTPUT, { recursive: true });
    writeFileSync(`${process.env.EVIDENCE_PROOF_OUTPUT}/local-proof.json`, JSON.stringify({ backend: url, localOnly: true, records }, null, 2));
  }
});
