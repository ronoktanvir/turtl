import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { evidenceServer } from "./fixtures/evidence-http.mjs";

const config = JSON.parse(readFileSync(new URL("../.convex/local/default/config.json", import.meta.url), "utf8"));
const client = new ConvexHttpClient(`http://127.0.0.1:${config.ports.cloud}`);
client.setAdminAuth(config.adminKey);
const mutation = (name, args) => client.mutation(makeFunctionReference(name), args);
const snapshot = (caseId) => client.query(makeFunctionReference("evidence/localProof:snapshot"), { caseId });
const step = (data, key) => data.steps.find((row) => row.key === key);
const attempts = (data, key) => data.attempts.filter((row) => row.stepId === step(data, key)._id);
const accepted = ({ lateResult, lateResultAt, ...row }) => row;

async function until(caseId, predicate, label) {
  const deadline = Date.now() + 15_000;
  let data;
  while (Date.now() < deadline) {
    data = await snapshot(caseId);
    if (predicate(data)) return data;
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(data?.steps.map((row) => ({ key: row.key, status: row.status, error: row.currentAttempt?.error })))}`);
}

test("local collector attempts and dependency gates independently of gather implementation", { timeout: 60_000 }, async (t) => {
  const server = await evidenceServer();
  t.after(() => server.close());
  const seed = async (source) => (await mutation("evidence/localProof:seed", {
    base: source.base, label: source.name, mode: "parallel",
  })).caseId;

  await t.test("real HTTP reads overlap in two attempts and the join remains blocked by either collector", async () => {
    const source = server.add("collector-overlap", { holdFlags: true, holdErrors: true });
    const caseId = await seed(source);
    const both = await until(caseId, (data) => ["collect_app_state", "collect_error_window"].every((key) => step(data, key).status === "running") && source.events.some((event) => event.resource === "flags") && source.errorReads === 1, "two real collectors did not start");
    assert.equal(step(both, "gather_context").status, "pending");
    assert.equal(attempts(both, "gather_context").length, 0);
    assert.ok(source.events.some((event) => event.resource === "flags" && !event.finishedAt));
    assert.ok(source.events.some((event) => event.resource === "errors" && !event.finishedAt));
    source.flagsGate.release();
    await until(caseId, (data) => step(data, "collect_app_state").status === "done", "app-state did not finish independently");
    await delay(1_300);
    const blocked = await snapshot(caseId);
    assert.equal(step(blocked, "collect_error_window").status, "running");
    assert.equal(step(blocked, "gather_context").status, "pending");
    assert.equal(attempts(blocked, "gather_context").length, 0);
    source.release();
    const data = await until(caseId, (row) => !!step(row, "gather_context").currentAttempt, "join did not capture completed dependencies");
    const state = step(data, "collect_app_state").currentAttempt;
    const errors = step(data, "collect_error_window").currentAttempt;
    assert.ok(Math.max(state.startedAt, errors.startedAt) < Math.min(state.finishedAt, errors.finishedAt));
    assert.deepEqual(new Set(step(data, "gather_context").currentAttempt.inputRefs), new Set([state._id, errors._id]));
    for (const [key, parent] of [["collect_app_state", state], ["collect_error_window", errors]]) {
      assert.equal(parent.output.collector, key);
      assert.equal(parent.output.attemptId, parent._id);
      assert.equal(parent.output.caseId, caseId);
      for (const entry of parent.output.evidence) {
        const original = data.evidence.find((row) => row._id === entry.id);
        assert.equal(original.stepAttemptId, parent._id);
        assert.equal(original.stepId, parent.stepId);
        assert.equal(original.observedAt, entry.observedAt);
        assert.equal(original.environment, entry.environment);
        assert.deepEqual(original.revision, entry.revision);
      }
    }
    assert.equal(data.actions.length, 0);
  });

  await t.test("a failed error collector alone gets a new attempt and the join pins that retry", async () => {
    const source = server.add("collector-retry", { failErrors: 1 });
    const caseId = await seed(source);
    const data = await until(caseId, (row) => !!step(row, "gather_context").currentAttempt, "collector retry did not reach its dependency gate");
    assert.equal(attempts(data, "collect_app_state").length, 1);
    const errors = attempts(data, "collect_error_window");
    assert.deepEqual(errors.map((row) => row.status), ["failed", "done"]);
    assert.deepEqual(errors.map((row) => row.attempt), [1, 2]);
    assert.equal(errors[1].output.facts["errors.failedBookings"], 3);
    const consumed = step(data, "gather_context").currentAttempt.inputRefs;
    assert.ok(consumed.includes(errors[1]._id));
    assert.ok(!consumed.includes(errors[0]._id));
    await mutation("runner/run:recordResult", { attemptId: errors[1]._id, result: { status: "failed", error: "Local duplicate failure after accepted success" } });
    const after = await snapshot(caseId);
    assert.deepEqual(accepted(step(after, "collect_error_window").currentAttempt), accepted(errors[1]));
    assert.deepEqual(step(after, "gather_context").currentAttempt.inputRefs, consumed);
  });

  await t.test("a late real HTTP response after timeout stays diagnostic after a sibling retry and join start", async () => {
    const source = server.add("collector-timeout", { holdFirstError: true, lateFirst: true });
    const caseId = await seed(source);
    const started = await until(caseId, (row) => step(row, "collect_error_window").status === "running" && source.errorReads === 1, "held HTTP collector did not start");
    const expired = step(started, "collect_error_window").currentAttempt;
    await mutation("runner/run:checkTimeout", { attemptId: expired._id, limitMs: 1 });
    const joined = await until(caseId, (row) => !!step(row, "gather_context").currentAttempt, "timed-out collector was not retried");
    const current = step(joined, "collect_error_window").currentAttempt;
    assert.equal(current.attempt, 2);
    assert.equal(attempts(joined, "collect_app_state").length, 1);
    source.firstErrorsGate.release();
    const after = await until(caseId, (row) => !!row.attempts.find((attempt) => attempt._id === expired._id)?.lateResultAt, "actual late response was not retained");
    const late = after.attempts.find((row) => row._id === expired._id);
    assert.equal(late.status, "failed");
    assert.equal(late.output, undefined);
    assert.equal(late.lateResult.output.facts["errors.failedBookings"], 9);
    assert.deepEqual(accepted(step(after, "collect_error_window").currentAttempt), accepted(current));
    assert.equal(current.output.facts["errors.failedBookings"], 3);
    assert.deepEqual(step(after, "gather_context").currentAttempt.inputRefs, step(joined, "gather_context").currentAttempt.inputRefs);
  });
});
