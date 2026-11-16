import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { v } from "convex/values";
import ts from "typescript";

function load(path, imports, processOverride = process) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module, process) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; },
    module.exports,
    module,
    processOverride,
  );
  return module.exports;
}

const constants = load("../convex/constants.ts", { "convex/values": { v } });
const workflow = load("../convex/workflow.ts", {
  "convex/values": { v },
  "./_generated/server": { internalMutation: (config) => config },
  "./constants": constants,
});

function fixture(status = "done") {
  const rows = new Map([
    ["step", { _id: "step", currentAttemptId: "accepted", status }],
    ["accepted", {
      _id: "accepted", stepId: "step", status, finishedAt: 200,
      inputRefs: ["detection"], output: { facts: { "health.ok": true } },
      outputRefs: [{ kind: "evidence", id: "original" }], summary: "Accepted observation",
    }],
  ]);
  return {
    rows,
    ctx: { db: {
      get: async (id) => structuredClone(rows.get(id) ?? null),
      patch: async (id, patch) => rows.set(id, { ...rows.get(id), ...structuredClone(patch) }),
    } },
  };
}

test("late callbacks cannot replace an accepted observation consumed by a join", async () => {
  const { ctx, rows } = fixture();
  const before = structuredClone(rows.get("accepted"));
  const late = { output: { facts: { "health.ok": false } }, summary: "Late observation" };
  await workflow.recordLateResult(ctx, "accepted", late);
  const after = rows.get("accepted");
  for (const key of ["output", "outputRefs", "inputRefs", "status", "finishedAt", "summary"]) {
    assert.deepEqual(after[key], before[key], `Accepted ${key} changed`);
  }
  assert.deepEqual(after.lateResult, late);
  assert.equal(typeof after.lateResultAt, "number");
  assert.equal(rows.get("step").status, "done");
});

test("late success after timeout is diagnostic and cannot supersede the retry", async () => {
  const { ctx, rows } = fixture("failed");
  rows.set("step", { _id: "step", currentAttemptId: "retry", status: "done" });
  rows.set("retry", { _id: "retry", stepId: "step", status: "done", output: { observed: "retry" } });
  const before = structuredClone(rows.get("accepted"));
  await workflow.recordLateResult(ctx, "accepted", { output: { observed: "late" }, summary: "Late success" });
  assert.deepEqual(rows.get("accepted").output, before.output);
  assert.equal(rows.get("accepted").status, "failed");
  assert.equal(rows.get("accepted").finishedAt, before.finishedAt);
  assert.deepEqual(rows.get("retry").output, { observed: "retry" });
  assert.equal(rows.get("step").currentAttemptId, "retry");
});

test("a live attempt cannot be recorded as late", async () => {
  const { ctx } = fixture("running");
  await assert.rejects(workflow.recordLateResult(ctx, "accepted", { summary: "Not late" }), /still current/);
});

function database() {
  const rows = new Map();
  let sequence = 0;
  return { rows, db: {
    get: async (id) => structuredClone(rows.get(id) ?? null),
    insert: async (table, row) => {
      const id = `${table}:${++sequence}`;
      rows.set(id, { ...structuredClone(row), _id: id, _creationTime: sequence });
      return id;
    },
    patch: async (id, patch) => rows.set(id, { ...rows.get(id), ...structuredClone(patch) }),
    query(table) {
      let matches = [...rows.values()].filter((row) => row._id.startsWith(`${table}:`));
      const chain = {
        withIndex(_name, filter) {
          const q = { eq(field, value) { matches = matches.filter((row) => row[field] === value); return q; } };
          filter(q);
          return chain;
        },
        order(direction) { if (direction === "desc") matches.reverse(); return chain; },
        first: async () => structuredClone(matches[0] ?? null),
        unique: async () => { assert.ok(matches.length <= 1); return structuredClone(matches[0] ?? null); },
        collect: async () => structuredClone(matches),
      };
      return chain;
    },
  } };
}

test("the fixed fork retains all eight canonical keys and purposes, and the six-card groups cover collectors", () => {
  assert.equal(workflow.TEMPLATE_STEPS.length, 8);
  assert.equal(workflow.EVIDENCE_TEMPLATE_STEPS.length, 10);
  for (const original of workflow.TEMPLATE_STEPS) {
    const current = workflow.EVIDENCE_TEMPLATE_STEPS.find((item) => item.key === original.key);
    assert.equal(current.purpose, original.purpose);
    assert.equal(current.kind, original.kind);
    if (current.purpose !== "gather_context") assert.deepEqual(current.dependsOn, original.dependsOn);
  }
  assert.deepEqual(workflow.EVIDENCE_TEMPLATE_STEPS.find((item) => item.key === "gather_context").dependsOn,
    ["collect_app_state", "collect_error_window"]);
  const { CARDS } = load("../components/feed/cards.ts", { "../../convex/constants": constants });
  assert.equal(CARDS.length, 6);
  for (const item of workflow.EVIDENCE_TEMPLATE_STEPS) {
    assert.equal(CARDS.filter((card) => card.purposes.includes(item.purpose)).length, 1);
  }
});

test("explicit ordering is stable and respects dependencies even when their purpose normally sorts later", () => {
  const input = [...workflow.EVIDENCE_TEMPLATE_STEPS].reverse();
  assert.deepEqual(workflow.orderSteps(input).map((item) => item.key), workflow.EVIDENCE_TEMPLATE_STEPS.map((item) => item.key));
  const unusual = [
    { key: "child", purpose: "detect_or_receive", dependsOn: ["parent"] },
    { key: "parent", purpose: "learn", dependsOn: [] },
    { key: "unknown", purpose: "future-purpose", dependsOn: ["child"] },
  ];
  assert.deepEqual(workflow.orderSteps(unusual).map((item) => item.key), ["parent", "child", "unknown"]);
  assert.throws(() => workflow.orderSteps([{ key: "bad", purpose: "learn", dependsOn: ["missing"] }]), /missing dependency or a cycle/);
});

test("durable dependency gates pin the exact successful sibling attempts and keep verification mandatory", async () => {
  const ctx = database();
  const caseId = await workflow.createCaseFromTemplate(ctx, {
    appId: "app", title: "Local fixture", impact: "Fixture only", kind: "outage", raisedBy: "owner",
  }, workflow.EVIDENCE_TEMPLATE_STEPS);
  const byKey = Object.fromEntries((await workflow.loadSteps(ctx, caseId)).map((item) => [item.key, item]));
  const detection = await workflow.startAttempt(ctx, byKey.detect_or_receive._id);
  await assert.rejects(workflow.startAttempt(ctx, byKey.collect_app_state._id), /not done or skipped/);
  await workflow.finishAttempt(ctx, detection, { status: "done" });
  const state = await workflow.startAttempt(ctx, byKey.collect_app_state._id);
  const failed = await workflow.startAttempt(ctx, byKey.collect_error_window._id);
  await workflow.finishAttempt(ctx, state, { status: "done", output: { read: "app-state" } });
  await assert.rejects(workflow.startAttempt(ctx, byKey.gather_context._id), /not done or skipped/);
  await workflow.finishAttempt(ctx, failed, { status: "failed", error: "Read failed" });
  await assert.rejects(workflow.startAttempt(ctx, byKey.gather_context._id), /not done or skipped/);
  const retry = await workflow.startAttempt(ctx, byKey.collect_error_window._id);
  assert.equal(ctx.rows.get(retry).attempt, 2);
  await workflow.finishAttempt(ctx, retry, { status: "done", output: { read: "error-window" } });
  const join = await workflow.startAttempt(ctx, byKey.gather_context._id);
  assert.deepEqual(ctx.rows.get(join).inputRefs, [state, retry]);
  const source = structuredClone(ctx.rows.get(retry));
  await workflow.recordLateResult(ctx, failed, { status: "done", output: { read: "wrong-old-window" } });
  await workflow.recordLateResult(ctx, retry, { status: "failed", error: "Late failure" });
  assert.deepEqual(ctx.rows.get(retry).output, source.output);
  assert.deepEqual(ctx.rows.get(join).inputRefs, [state, retry]);
  assert.equal(ctx.rows.get(byKey.gather_context._id).status, "running");
  await assert.rejects(workflow.skipStep(ctx, byKey.verify._id, "No proof"), /only on a declined case/);
});

test("local evidence fixtures refuse external provider configuration before inserting or scheduling", async () => {
  for (const variable of ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY", "KEIKI_API_KEY", "KEIKI_AGENT_ID", "REVYL_API_KEY", "REVYL_BOOKING_WORKFLOW_ID", "CAPY_API_KEY", "GITHUB_TOKEN", "PROTECTED_APP_URL", "ANTHROPIC_API_KEY"]) {
    let touched = false;
    const proof = load("../convex/evidence/localProof.ts", {
      "convex/values": { v },
      "../_generated/api": { internal: { runner: { run: { advance: "advance" } } } },
      "../_generated/server": { internalMutation: (config) => config, internalQuery: (config) => config },
      "../protectedApp/client": { CREDENTIAL_REF: "LOCAL_FIXTURE", CHECK_VERSION: "fixture" },
      "../runner/run": { startCaseRun: async () => { touched = true; return "case"; } },
      "../workflow": workflow,
    }, { env: { CONVEX_CLOUD_URL: "http://127.0.0.1:3210", DEV_TOOLS_ENABLED: "true", EVIDENCE_LOCAL_PROOF: "true", [variable]: "fixture-value-not-a-credential" } });
    const ctx = { db: { insert: async () => { touched = true; return "fixture"; } } };
    await assert.rejects(proof.seed.handler(ctx, { base: "http://127.0.0.1:4321/mock", label: "guard", mode: "no_journey" }), /provider|external|configuration/i, variable);
    assert.equal(touched, false, `${variable} was detected only after a side effect`);
  }
});
