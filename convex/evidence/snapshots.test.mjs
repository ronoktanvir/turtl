import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    }, module.exports, module,
  );
  return module.exports;
}

const snapshots = load("./snapshots.ts");
const client = load("../protectedApp/client.ts");
const { validateHealth, validateFlags, validateRevisionResponse, validateErrors, validateSnapshot, joinSnapshots } = snapshots;
const base = "https://source.example/control";
const deployment = { deploymentId: "source.example" };
const appRevision = { ...deployment, buildId: "build-7" };
const roles = ["collect_app_state", "collect_error_window"];
const errorBody = () => ({
  window: { since: 100, until: 200, truncated: false, sampleLimit: 1000 },
  counts: { totalBookings: 4, failedBookings: 1, successfulBookings: 3, errorRate: 0.25 },
  errors: [{ code: "BOOKING_STORE_UNAVAILABLE", step: "submit_booking", timestamp: 150 }],
});

function fixture() {
  const make = (role) => {
    const app = role === roles[0];
    const stepId = `${role}-step`;
    const attemptId = `${role}-attempt-1`;
    const evidence = (app ? [["health", "GET /health"], ["flags", "GET /flags"], ["revision", "GET /revision"]] : [["errors", "GET /errors"]])
      .map(([kind, sourceRef]) => ({ id: `${kind}-evidence`, kind, sourceRef, observedAt: 210, environment: "protected-app", revision: kind === "revision" ? appRevision : deployment }));
    const output = {
      version: 1, collector: role, caseId: "case-1", stepId, attemptId,
      facts: app ? { "health.ok": false, "flags.recommendationsEnabled": false, "app.revision": "build-7" } : { "errors.totalBookings": 4, "errors.failedBookings": 1, "errors.errorRate": 0.25, "errors.topCode": "BOOKING_STORE_UNAVAILABLE" },
      missing: [], revision: app ? appRevision : deployment, evidence,
      ...(!app && { window: errorBody().window }),
    };
    return {
      step: { _id: stepId, caseId: "case-1", key: role, purpose: role, kind: "function", status: "done", currentAttemptId: attemptId, dependsOn: ["detect_or_receive"] },
      attempt: { _id: attemptId, caseId: "case-1", stepId, status: "done", output },
    };
  };
  const parents = roles.map(make);
  const input = {
    case: { _id: "case-1", journeyId: "journey-1" },
    step: { _id: "join-step", caseId: "case-1", key: "gather_context", purpose: "gather_context", kind: "function", status: "running", dependsOn: [...roles] },
    attempt: { _id: "join-attempt", caseId: "case-1", stepId: "join-step", status: "running", inputRefs: parents.map(({ attempt }) => attempt._id) },
    parents, previousAttempts: [],
  };
  const context = {
    app: { productionUrl: base }, base, journey: { _id: "journey-1", check: { kind: "http", config: { url: `${base}/journey-check` } } },
    steps: parents.map(({ step, attempt }) => ({ ...step, currentAttempt: attempt })),
    evidence: parents.flatMap(({ attempt }) => attempt.output.evidence.map(({ id, ...entry }) => ({ _id: id, ...entry, title: `Observed ${entry.kind}`, body: `Original ${entry.kind} observation.`, url: `${base}/observed/${entry.kind}`, caseId: "case-1", stepId: attempt.stepId, stepAttemptId: attempt._id }))),
  };
  return { input, context };
}

test("validated source booleans preserve false rather than treating it as missing", () => {
  assert.equal(validateHealth({ ok: false }).ok, false);
  assert.equal(validateFlags({ recommendationsEnabled: false }).recommendationsEnabled, false);
  for (const value of [null, [], {}, { ok: 0 }, { ok: "true" }, { ok: true, timestamp: NaN }, { ok: true, environment: "" }, { ok: true, revision: null }]) {
    assert.throws(() => validateHealth(value));
  }
  for (const value of [null, {}, { recommendationsEnabled: "false" }, { recommendationsEnabled: true, updatedAt: -1 }]) {
    assert.throws(() => validateFlags(value));
  }
  for (const value of [null, {}, { revision: " " }, { revision: 7 }, { revision: "build-7", environment: [] }]) {
    assert.throws(() => validateRevisionResponse(value));
  }
});

test("error responses require bounded finite counts, consistent rates, a window and typed error samples", () => {
  assert.deepEqual(validateErrors(errorBody()).counts, errorBody().counts);
  const zero = errorBody();
  zero.counts = { totalBookings: 0, failedBookings: 0, successfulBookings: 0, errorRate: 0 };
  zero.errors = [];
  assert.equal(client.topErrorCode(validateErrors(zero)), "none");
  const sampled = errorBody();
  sampled.counts = { totalBookings: 1000, failedBookings: 30, successfulBookings: 970, errorRate: 0.03 };
  sampled.errors = Array.from({ length: 20 }, () => ({ ...sampled.errors[0] }));
  sampled.window.truncated = true;
  assert.equal(validateErrors(sampled).errors.length, 20);
  const invalid = [
    (x) => { x.counts.totalBookings = Infinity; },
    (x) => { x.counts.totalBookings = -1; },
    (x) => { x.counts.failedBookings = 0.5; },
    (x) => { x.counts.failedBookings = 5; },
    (x) => { x.counts.successfulBookings = 1; },
    (x) => { delete x.counts.successfulBookings; },
    (x) => { x.counts.errorRate = NaN; },
    (x) => { x.counts.errorRate = 1.5; },
    (x) => { x.counts.errorRate = 0.9; },
    (x) => { x.window.since = 201; },
    (x) => { x.window.until = Infinity; },
    (x) => { delete x.window.truncated; },
    (x) => { x.window.sampleLimit = 0; },
    (x) => { x.window.sampleLimit = 3; },
    (x) => { x.window.truncated = true; },
    (x) => { x.errors = null; },
    (x) => { x.errors = []; },
    (x) => { x.errors.push({ ...x.errors[0] }); },
    (x) => { delete x.errors[0].code; },
    (x) => { x.errors[0].code = "none"; },
    (x) => { x.errors[0].step = ""; },
    (x) => { x.errors[0].timestamp = 201; },
    (x) => { x.errors[0].timestamp = -1; },
    (x) => { x.errors[0].retryable = "true"; },
    (x) => { x.errors[0].revision = 4; },
    (x) => { x.environment = false; },
  ];
  for (const mutate of invalid) {
    const value = errorBody();
    mutate(value);
    assert.throws(() => validateErrors(value), mutate.toString());
  }
});

test("successful version-1 snapshots validate exact roles, source entries and facts", () => {
  const { input } = fixture();
  for (const [i, role] of roles.entries()) assert.equal(validateSnapshot(input.parents[i].attempt.output, role).collector, role);
  assert.throws(() => validateSnapshot(input.parents[0].attempt.output, roles[1]));
  const invalid = [
    (x) => { x.version = 2; },
    (x) => { x.caseId = ""; },
    (x) => { delete x.attemptId; },
    (x) => { x.missing = ["health"]; },
    (x) => { delete x.facts["health.ok"]; },
    (x) => { x.facts["health.ok"] = null; },
    (x) => { x.facts["errors.errorRate"] = 0; },
    (x) => { x.revision.buildId = "another-build"; },
    (x) => { x.evidence.pop(); },
    (x) => { x.evidence[1].id = x.evidence[0].id; },
    (x) => { x.evidence[1].kind = "health"; },
    (x) => { x.evidence[0].sourceRef = "POST /health"; },
    (x) => { x.evidence[0].observedAt = NaN; },
    (x) => { x.evidence[0].environment = ""; },
    (x) => { x.evidence[0].revision = {}; },
    (x) => { x.evidence[0].revision = { buildId: "build-7" }; },
    (x) => { x.evidence[0].revision = { commitSha: "unknown" }; },
    (x) => { x.window = errorBody().window; },
  ];
  for (const mutate of invalid) {
    const snapshot = structuredClone(input.parents[0].attempt.output);
    mutate(snapshot);
    assert.throws(() => validateSnapshot(snapshot, roles[0]), mutate.toString());
  }
  const invalidErrors = [
    (x) => { delete x.window; },
    (x) => { x.window.since = -1; },
    (x) => { x.facts["errors.totalBookings"] = NaN; },
    (x) => { x.facts["errors.failedBookings"] = 7; },
    (x) => { x.facts["errors.errorRate"] = 0; },
    (x) => { x.facts["errors.topCode"] = "none"; },
    (x) => { x.evidence[0].revision = appRevision; },
  ];
  for (const mutate of invalidErrors) {
    const errors = structuredClone(input.parents[1].attempt.output);
    mutate(errors);
    assert.throws(() => validateSnapshot(errors, roles[1]), mutate.toString());
  }
});

test("the join consumes exact pinned snapshots, even when a newer parent attempt exists", () => {
  const { input, context } = fixture();
  input.parents[0].step.currentAttemptId = "newer-attempt";
  context.steps[0].currentAttempt = { _id: "newer-attempt", output: { facts: { "health.ok": true } } };
  const result = joinSnapshots(input, context);
  assert.equal(result.facts["health.ok"], false);
  assert.equal(result.facts["flags.recommendationsEnabled"], false);
  assert.equal(result.facts["errors.failedBookings"], 1);
  assert.deepEqual(result.revision, appRevision);
  assert.equal(result.readCount, 4);
  assert.equal(result.sourceCount, 4);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.refs.map(({ id }) => id), ["health-evidence", "flags-evidence", "revision-evidence", "errors-evidence"]);
  assert.deepEqual(input.parents[1].attempt.output.revision, deployment);
});

test("the join rejects missing, skipped, failed, mixed, unpinned or wrong-role parents", () => {
  const invalid = [
    (x) => { x.input.parents.pop(); },
    (x) => { x.input.step.dependsOn = [roles[0]]; },
    (x) => { x.input.step.dependsOn = [roles[0], roles[0]]; },
    (x) => { x.input.step.purpose = roles[0]; },
    (x) => { x.input.step.key = "other"; },
    (x) => { x.input.step.kind = "agent"; },
    (x) => { x.input.attempt.caseId = "case-2"; },
    (x) => { x.input.attempt.stepId = "other"; },
    (x) => { x.input.parents[0].step.purpose = "gather_context"; },
    (x) => { x.input.parents[0].step.key = "other"; },
    (x) => { x.input.parents[0].step.status = "skipped"; },
    (x) => { x.input.parents[0].step.kind = "agent"; },
    (x) => { x.input.parents[0].step.caseId = "case-2"; },
    (x) => { x.input.parents[0].attempt = null; },
    (x) => { x.input.parents[0].attempt.status = "failed"; },
    (x) => { x.input.parents[0].attempt.status = "waiting"; },
    (x) => { x.input.parents[0].attempt.caseId = "case-2"; },
    (x) => { x.input.parents[0].attempt.stepId = "other-step"; },
    (x) => { x.input.parents[0].attempt.output.attemptId = "other-attempt"; },
    (x) => { x.input.parents[0].attempt.output.caseId = "case-2"; },
    (x) => { x.input.parents[0].attempt.output.stepId = "other-step"; },
    (x) => { x.input.parents[0].attempt.output = x.input.parents[1].attempt.output; },
    (x) => { x.input.attempt.inputRefs = []; },
    (x) => { x.input.attempt.inputRefs[0] = "other-attempt"; },
    (x) => { x.input.attempt.inputRefs.push("extra"); },
  ];
  for (const mutate of invalid) {
    const value = fixture();
    mutate(value);
    assert.throws(() => joinSnapshots(value.input, value.context), mutate.toString());
  }
});

test("snapshot evidence must equal original recorded ownership and every provenance field", () => {
  const invalid = [
    (x) => { x.context.evidence.shift(); },
    (x) => { x.context.evidence.push(x.context.evidence[0]); },
    (x) => { x.context.evidence[0].caseId = "case-2"; },
    (x) => { x.context.evidence[0].stepId = "other-step"; },
    (x) => { x.context.evidence[0].stepAttemptId = "other-attempt"; },
    (x) => { x.context.evidence[0].kind = "revision"; },
    (x) => { x.context.evidence[0].sourceRef = "GET /revision"; },
    (x) => { x.context.evidence[0].observedAt += 1; },
    (x) => { x.context.evidence[0].environment = "other"; },
    (x) => { x.context.evidence[0].revision = appRevision; },
    (x) => { x.input.parents[0].attempt.output.evidence[0].revision = appRevision; },
  ];
  for (const mutate of invalid) {
    const value = fixture();
    mutate(value);
    assert.throws(() => joinSnapshots(value.input, value.context), mutate.toString());
  }
});

test("the join rejects conflicting source identities even when each snapshot matches its recorded evidence", () => {
  function updateSource(value, collector, kind, changes) {
    const snapshot = value.input.parents[collector].attempt.output;
    const entry = snapshot.evidence.find((entry) => entry.kind === kind);
    Object.assign(entry, changes);
    Object.assign(value.context.evidence.find((row) => row._id === entry.id), changes);
    if (changes.revision && (kind === "revision" || kind === "errors")) snapshot.revision = changes.revision;
  }
  for (const [collector, kind] of [[0, "health"], [0, "flags"], [0, "revision"], [1, "errors"]]) {
    const environment = fixture();
    updateSource(environment, collector, kind, { environment: "another-environment" });
    assert.throws(() => joinSnapshots(environment.input, environment.context), /conflicting source environments/);
    const deployment = fixture();
    const entry = deployment.input.parents[collector].attempt.output.evidence.find((entry) => entry.kind === kind);
    updateSource(deployment, collector, kind, { revision: { ...entry.revision, deploymentId: "another-source.example" } });
    assert.throws(() => joinSnapshots(deployment.input, deployment.context), /conflicting source deployments/);
  }
  for (const [collector, kind] of [[0, "health"], [0, "flags"], [1, "errors"]]) {
    for (const revision of [{ ...deployment, buildId: "another-build" }, { ...deployment, commitSha: "abcdef1234567" }]) {
      const value = fixture();
      updateSource(value, collector, kind, { revision });
      assert.throws(() => joinSnapshots(value.input, value.context), /source revision that conflicts with app.revision/);
    }
  }
  const matching = fixture();
  for (const [collector, kind] of [[0, "health"], [0, "flags"], [0, "revision"], [1, "errors"]]) {
    updateSource(matching, collector, kind, { environment: "source-stage", revision: { ...appRevision } });
  }
  assert.equal(joinSnapshots(matching.input, matching.context).readCount, 4);
  const unknown = fixture();
  const before = structuredClone(unknown);
  joinSnapshots(unknown.input, unknown.context);
  assert.deepEqual(unknown, before);
  assert.deepEqual(unknown.input.parents[1].attempt.output.revision, deployment);
  assert.equal(unknown.input.parents[0].attempt.output.evidence[0].revision.buildId, undefined);
});

function harness(responses = {}) {
  const calls = [];
  const rows = [];
  const { input, context } = fixture();
  const internal = { protectedApp: { records: { addEvidence: "addEvidence", caseContext: "caseContext" } }, evidence: { records: { projectEvidence: "projectEvidence" } } };
  const httpClient = {
    ...client,
    call: async (url, options = {}) => {
      const path = url.slice(base.length);
      calls.push({ path, ...options });
      assert.ok(Object.hasOwn(responses, path), `No mock response for ${path}`);
      const response = responses[path];
      return typeof response === "function" ? response() : response;
    },
  };
  // The demo's watched app: with accounts off watchedApp hands back DEMO_APP (convex/protectedApp/watched.ts).
  const watched = { watchedApp: async () => client.DEMO_APP };
  const journey = load("../runner/handlers/journey.ts", { "../../_generated/api": { internal }, "../../protectedApp/client": httpClient, "../../protectedApp/watched": watched });
  const collectors = load("./collectors.ts", { "../_generated/api": { internal }, "../protectedApp/client": httpClient, "../runner/handlers/journey": journey, "./snapshots": snapshots });
  const reader = load("./context.ts", { "../_generated/api": { internal }, "./collectors": collectors, "./snapshots": snapshots });
  const records = load("./records.ts", { "convex/values": { v: { id: () => ({}) } }, "../_generated/server": { internalMutation: (config) => config }, "./snapshots": snapshots });
  const documents = new Map([input.case, input.step, input.attempt, ...input.parents.flatMap(({ step, attempt }) => [step, attempt])].map((doc) => [doc._id, doc]));
  const db = {
    get: async (id) => documents.get(id) ?? null,
    query: (table) => {
      assert.equal(table, "evidence");
      return { withIndex: (name, filter) => {
        assert.ok(name === "by_case" || name === "by_attempt");
        let field;
        let value;
        filter({ eq: (key, expected) => { assert.equal(key, name === "by_case" ? "caseId" : "stepAttemptId"); field = key; value = expected; } });
        return { collect: async () => [...context.evidence, ...rows].filter((row) => row[field] === value) };
      } };
    },
    insert: async (table, row) => {
      assert.equal(table, "evidence");
      const id = `written-${rows.length}`;
      rows.push({ _id: id, ...row });
      return id;
    },
  };
  const ctx = {
    runQuery: async (ref) => { assert.equal(ref, "caseContext"); return context; },
    runMutation: async (ref, args) => {
      if (ref === "projectEvidence") return records.projectEvidence.handler({ db }, args);
      assert.equal(ref, "addEvidence");
      return Promise.all(args.rows.map((row) => db.insert("evidence", row)));
    },
  };
  return { ...collectors, ...reader, calls, rows, input, context, ctx, db, records, documents };
}

const response = (body, status = 200) => ({ kind: "response", status, body, durationMs: 1 });
const goodResponses = () => ({ "/health": response({ ok: false }), "/flags": response({ recommendationsEnabled: false }), "/revision": response({ revision: "build-7", environment: "source-stage" }), "/errors": response(errorBody()) });

test("independent collectors only GET their own sources and produce attempt-owned snapshots", async () => {
  const h = harness(goodResponses());
  const outputs = [];
  for (const [i, handler] of [h.appStateHandler, h.errorWindowHandler].entries()) {
    const parent = h.input.parents[i];
    const input = { ...h.input, step: parent.step, attempt: parent.attempt };
    const result = await handler.run(h.ctx, input);
    assert.equal(result.status, "done");
    validateSnapshot(result.output, roles[i]);
    outputs.push(result.output);
    for (const evidence of result.output.evidence) {
      const row = h.rows.find(({ _id }) => _id === evidence.id);
      assert.equal(row.stepId, input.step._id);
      assert.equal(row.stepAttemptId, input.attempt._id);
      assert.equal(row.caseId, input.case._id);
    }
  }
  assert.deepEqual(h.calls.map(({ path }) => path).sort(), ["/errors", "/flags", "/health", "/revision"]);
  assert.ok(h.calls.every(({ method }) => !method || method === "GET"));
  assert.deepEqual(outputs[0].revision, appRevision);
  assert.equal(outputs[0].evidence.find(({ kind }) => kind === "revision").environment, "source-stage");
  assert.deepEqual(outputs[1].revision, deployment);
  assert.equal(outputs[1].evidence[0].environment, "protected-app");
  assert.deepEqual(outputs[1].window, errorBody().window);
});

test("error collector neither waits for app-state reads nor borrows their revision", async () => {
  const body = { ...errorBody(), revision: "error-source-build", environment: "error-source-stage" };
  const h = harness({ "/errors": response(body) });
  const parent = h.input.parents[1];
  const result = await h.errorWindowHandler.run(h.ctx, { ...h.input, step: parent.step, attempt: parent.attempt });
  assert.equal(result.status, "done");
  assert.deepEqual(h.calls.map(({ path }) => path), ["/errors"]);
  assert.deepEqual(result.output.revision, { ...deployment, buildId: "error-source-build" });
  assert.equal(result.output.evidence[0].environment, "error-source-stage");
});

test("required read failures fail only their collector and record honest failure evidence", async () => {
  for (const [path, bad] of [["/health", response({})], ["/flags", response({ recommendationsEnabled: "false" })], ["/revision", response({ revision: "" })], ["/errors", response(null)], ["/errors", response({ error: "no" }, 401)], ["/errors", { kind: "no_response", reason: "request timed out", durationMs: 10000 }]]) {
    const h = harness({ ...goodResponses(), [path]: bad });
    const index = path === "/errors" ? 1 : 0;
    const parent = h.input.parents[index];
    const handler = index ? h.errorWindowHandler : h.appStateHandler;
    const result = await handler.run(h.ctx, { ...h.input, step: parent.step, attempt: parent.attempt });
    assert.equal(result.status, "failed", path);
    assert.equal(result.output, undefined);
    const failed = h.rows.find((row) => row.sourceRef === `GET ${path}`);
    assert.ok(failed.title.startsWith("Could not read"));
    assert.deepEqual(failed.revision, deployment);
    assert.ok(!JSON.stringify({ result, rows: h.rows }).includes("Authorization"));
  }
});

test("collector-backed reader projects original provenance without replacement requests or observations", async () => {
  const h = harness();
  const originals = structuredClone(h.context.evidence);
  const result = await h.readAppEvidence(h.ctx, h.input, h.context);
  assert.equal(result.readCount, 4);
  assert.equal(h.calls.length, 0);
  assert.equal(h.rows.length, 4);
  assert.equal(result.refs.length, 8);
  assert.deepEqual(result.refs.slice(0, 4).map(({ id }) => id), originals.map(({ _id }) => _id));
  for (const [i, original] of originals.entries()) {
    const projection = h.rows[i];
    assert.equal(projection.stepId, h.input.step._id);
    assert.equal(projection.stepAttemptId, h.input.attempt._id);
    assert.equal(projection.sourceRef, `Copied from an earlier step: ${original.sourceRef}`);
    assert.equal(projection.copyOf, original._id);
    assert.doesNotMatch(projection.sourceRef, new RegExp(`${original._id}|${original.stepAttemptId}`));
    for (const key of ["kind", "title", "body", "url", "observedAt", "environment", "revision"]) assert.deepEqual(projection[key], original[key]);
  }
  assert.deepEqual(h.context.evidence, originals);
  const repeated = await h.readAppEvidence(h.ctx, h.input, h.context);
  assert.deepEqual(repeated, result);
  assert.equal(h.rows.length, 4);
  assert.equal(repeated.readCount, 4);
  const partial = harness();
  partial.input.parents.pop();
  partial.context.steps.pop();
  await assert.rejects(() => partial.readAppEvidence(partial.ctx, partial.input, partial.context));
  assert.equal(partial.calls.length, 0);
  const wrongRole = harness();
  wrongRole.context.steps = [];
  wrongRole.input.step.dependsOn = ["detect_or_receive"];
  wrongRole.input.parents = [{ step: { key: "detect_or_receive", purpose: "detect_or_receive" }, attempt: { output: { version: 1, collector: "unknown-collector" } } }];
  await assert.rejects(() => wrongRole.readAppEvidence(wrongRole.ctx, wrongRole.input, wrongRole.context));
  assert.equal(wrongRole.calls.length, 0);
});

test("projection mutation independently rejects unpinned, wrong-role and altered original evidence", async () => {
  const invalid = [
    (h) => { h.input.attempt.status = "failed"; },
    (h) => { h.input.attempt.inputRefs.pop(); },
    (h) => { h.input.parents[0].attempt.status = "failed"; },
    (h) => { h.input.parents[0].step.purpose = "gather_context"; },
    (h) => { h.input.parents[0].attempt.caseId = "other-case"; },
    (h) => { h.context.evidence[0].stepAttemptId = "other-attempt"; },
    (h) => { h.context.evidence[0].observedAt += 1; },
    (h) => { h.documents.delete(h.input.parents[0].attempt._id); },
  ];
  for (const mutate of invalid) {
    const h = harness();
    mutate(h);
    await assert.rejects(() => h.records.projectEvidence.handler({ db: h.db }, { attemptId: h.input.attempt._id }));
    assert.equal(h.rows.length, 0);
  }
  const h = harness();
  await h.records.projectEvidence.handler({ db: h.db }, { attemptId: h.input.attempt._id });
  h.rows[0].observedAt += 1;
  await assert.rejects(() => h.records.projectEvidence.handler({ db: h.db }, { attemptId: h.input.attempt._id }), /differs from its original/);
});

test("legacy reader keeps four-read partial semantics and leaves unobserved facts absent", async () => {
  const h = harness({ ...goodResponses(), "/health": response({}), "/errors": response(null) });
  h.context.steps = [];
  h.input.parents = [];
  h.input.step.dependsOn = ["detect_or_receive"];
  const result = await h.readAppEvidence(h.ctx, h.input, h.context);
  assert.equal(result.readCount, 2);
  assert.equal(result.sourceCount, 4);
  assert.equal(Object.hasOwn(result.facts, "health.ok"), false);
  assert.equal(Object.hasOwn(result.facts, "errors.totalBookings"), false);
  assert.equal(result.facts["flags.recommendationsEnabled"], false);
  assert.equal(result.facts["app.revision"], "build-7");
  assert.equal(result.missing.length, 2);
  assert.match(result.missing[0], /health \(invalid response/);
  assert.match(result.missing[1], /failed bookings \(invalid response/);
  assert.equal(h.rows.length, 4);
  assert.ok(h.rows.find(({ kind }) => kind === "health").title.startsWith("Could not read"));
  assert.equal(h.calls.length, 4);
});
