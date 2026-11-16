import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { crc32, deflateSync } from "node:zlib";
import { zipSync } from "fflate";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) {
      try { return next(`${specifier}.ts`, context); }
      catch { return next(`${specifier}.js`, context); }
    }
    throw error;
  }
} });

const { parseProbeResult, evaluateProbe, REQUIRED_CRITERIA } = await import("../convex/externalApp/validators.ts");
const { extractArtifact, validatePng } = await import("../convex/externalApp/artifacts.ts");
const { dispatchWorkflow, findWorkflowRun, downloadArtifact, readRevision, readDiagnostics, readBytes } = await import("../convex/externalApp/probeClient.ts");
const records = await import("../convex/externalApp/probeRecords.ts");
const { startProbe, ingestArtifact } = await import("../convex/externalApp/probes.ts");

const sha = "a".repeat(40);
const config = {
  appId: "app", journeyId: "journey", actionCatalogId: "catalog", repo: "owner/game", baseBranch: "main",
  deploymentUrl: "https://game.example", environment: "demo", revisionPath: "/api/turtl/revision",
  githubCredentialRef: "PROBE_UNIT_TOKEN", probe: { workflow: "turtl-probe.yml", viewport: { width: 390, height: 844 }, timeoutMinutes: 15 },
  criteria: [], protectedPaths: [], deployTimeoutMinutes: 5,
};

function result() {
  return {
    probeId: "probe", verdict: "passed", failedStep: null, error: null, revision: sha, environment: "demo",
    fixture: { id: "large-v1", scoreCount: 1_600_000 }, deadlineMs: 2000, viewport: { width: 390, height: 844 },
    startedAt: 1000, completedAt: 5000,
    steps: [1, 2, 3].map((n) => ({ step: `answer_round_${n}`, verdict: "passed", detail: "Actual assertion belongs in the real browser probe.", durationMs: 10, request: { method: "POST", path: "/api/answer", status: 200, outcome: "ok", durationMs: 10 } })),
    criteria: REQUIRED_CRITERIA.map((id) => ({ id, status: "passed", detail: "Unit fixture, not gameplay proof." })),
    screenshots: [1, 2].map((n) => ({ file: `screenshots/0${n}-game.png`, step: `answer_round_${n}`, caption: "Unit-generated PNG, not browser evidence.", capturedAt: 2000 + n })),
    cleanup: { ok: true, deletedGames: 1, deletedScores: 1 },
  };
}

function failedResult() {
  const value = result();
  value.verdict = "failed";
  value.failedStep = "answer_round_1";
  value.error = { code: "ANSWER_TIMEOUT", message: "Answer timed out." };
  value.steps = [{ step: "answer_round_1", verdict: "failed", detail: "Timed out.", durationMs: 2001, request: { method: "POST", path: "/api/answer", status: 504, outcome: "timeout", durationMs: 2001 } }];
  value.criteria[0].status = "failed";
  value.criteria.slice(1).forEach((criterion) => { criterion.status = "not_run"; });
  value.screenshots = [value.screenshots[0]];
  return value;
}

function evaluate(value, changes = {}) {
  return evaluateProbe({ config, probeId: "probe", purpose: "monitor", revisionBefore: sha, revisionAfter: sha, result: parseProbeResult(value), ...changes });
}

function png(width = 390, height = 844) {
  const chunk = (name, data) => {
    const typeAndData = Buffer.concat([Buffer.from(name), data]);
    const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([header, typeAndData, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}

function archive(value = result(), image = png()) {
  return zipSync({ "result.json": Buffer.from(JSON.stringify(value)), ...Object.fromEntries(value.screenshots.map((shot) => [shot.file, image])) });
}

test("strict contract accepts complete success and a genuine answer-failure shape", () => {
  assert.equal(evaluate(result()).outcome, "passed");
  assert.equal(evaluate(failedResult()).outcome, "failed");
});

test("all six distinct required criteria are mandatory", () => {
  for (const mutate of [
    (r) => r.criteria.pop(), (r) => { r.criteria[0] = r.criteria[1]; },
    (r) => { r.criteria[0].id = "homepage_loaded"; }, (r) => { r.criteria[0].status = "not_run"; },
  ]) { const value = result(); mutate(value); assert.throws(() => parseProbeResult(value)); }
});

test("the fixture, probe ID, screenshots, cleanup counts and real request are required", () => {
  for (const mutate of [
    (r) => { delete r.probeId; }, (r) => { r.fixture = { id: "large-v1", counts: { scores: 1_600_000 } }; },
    (r) => { delete r.screenshots; }, (r) => { r.cleanup = { ok: true, detail: "clean" }; },
    (r) => { r.cleanup.deletedScores = -1; }, (r) => { r.cleanup.deletedGames = 0.5; },
    (r) => { r.steps.forEach((step) => { delete step.request; }); },
    (r) => { r.steps[0].request.durationMs = 2001; },
    (r) => { r.steps[0].request.status = 504; },
    (r) => { r.screenshots[0].file = "../secret.png"; },
    (r) => { r.screenshots[0].capturedAt = 999; },
    (r) => { r.screenshots[0].step = "not-a-step"; },
    (r) => { r.steps[0].request.headers = { Authorization: "must-not-be-stored" }; },
  ]) { const value = result(); mutate(value); assert.throws(() => parseProbeResult(value)); }
});

test("failure cannot be invented from a successful homepage", () => {
  const value = failedResult();
  delete value.steps[0].request;
  assert.equal(evaluate(value).outcome, "inconclusive");
  value.steps[0].request = { method: "GET", path: "/", status: 200, outcome: "ok", durationMs: 10 };
  assert.throws(() => parseProbeResult(value));
});

test("before, artifact and after revisions must agree with the expected deployment", () => {
  for (const changes of [{ revisionBefore: undefined }, { revisionAfter: undefined }, { revisionBefore: "b".repeat(40) }, { revisionAfter: "b".repeat(40) }, { expectedRevision: "b".repeat(40) }, { probeId: "other" }]) assert.equal(evaluate(result(), changes).outcome, "inconclusive");
});

test("verification freezes the same large fixture, deadline and viewport", () => {
  const baseline = { fixture: { id: "large-v1", scoreCount: 1_600_000 }, deadlineMs: 2000, viewport: { width: 390, height: 844 } };
  const input = { purpose: "verify", expectedRevision: sha, baseline };
  assert.equal(evaluate(result(), input).outcome, "passed");
  assert.equal(evaluate(result(), { purpose: "verify", expectedRevision: sha }).outcome, "inconclusive");
  assert.equal(evaluate(result(), { purpose: "verify", baseline }).outcome, "inconclusive");
  for (const mutate of [(r) => { r.fixture.id = "small"; }, (r) => { r.fixture.scoreCount--; }, (r) => { r.fixture.scoreCount++; }, (r) => { r.deadlineMs++; }, (r) => { r.viewport.width = 360; }]) {
    const value = result(); mutate(value); assert.equal(evaluate(value, input).outcome, "inconclusive");
  }
});

test("test doubles, another environment and unconfirmed cleanup can never establish proof", () => {
  assert.equal(evaluate(result(), { config: { ...config, isTestDouble: true } }).outcome, "inconclusive");
  const value = result(); value.cleanup.ok = false;
  assert.equal(evaluate(value).outcome, "inconclusive");
  value.cleanup.ok = true; value.environment = "preview";
  assert.equal(evaluate(value).outcome, "inconclusive");
});

test("PNG validates real pixel content, CRC, dimensions and complete decoding", () => {
  const bytes = png();
  assert.deepEqual(validatePng(bytes, config.probe.viewport), { width: 390, height: 844 });
  assert.throws(() => validatePng(bytes, { width: 360, height: 780 }));
  const corrupt = Buffer.from(bytes); corrupt[50] ^= 1;
  assert.throws(() => validatePng(corrupt, config.probe.viewport));
  assert.throws(() => validatePng(bytes.subarray(0, 33), config.probe.viewport));
  assert.throws(() => validatePng(Buffer.from("not a PNG"), config.probe.viewport));
});

test("ZIP extraction retains invalid or missing screenshots as visibly unavailable", () => {
  const extracted = extractArtifact(archive());
  assert.equal(extracted.screenshots.length, 2);
  assert.equal(extracted.screenshots[0].pixelWidth, 390);
  assert.ok(extracted.screenshots[0].bytes);
  const wrongSize = extractArtifact(archive(result(), png(360, 780)));
  assert.match(wrongSize.screenshots[0].unavailableReason, /dimensions/);
  assert.equal(wrongSize.screenshots[0].bytes, undefined);
  const missing = extractArtifact(zipSync({ "result.json": Buffer.from(JSON.stringify(result())) }));
  assert.match(missing.screenshots[0].unavailableReason, /did not contain/);
});

test("ZIP rejects traversal, unknown entries, oversized expansion and missing JSON", () => {
  for (const files of [
    { "../result.json": Buffer.from("{}") }, { "result.json": Buffer.from("{}"), "secret.txt": Buffer.from("private") },
    { "result.json": Buffer.alloc(129 * 1024) }, { "screenshots/too-big.png": Buffer.alloc(1_000_001) },
    { "screenshots/alone.png": png() },
  ]) assert.throws(() => extractArtifact(zipSync(files)));
});

test("GitHub dispatch sends only the agreed workflow inputs and reads the matching run", async (t) => {
  process.env.PROBE_UNIT_TOKEN = "unit-test-only";
  t.after(() => { delete process.env.PROBE_UNIT_TOKEN; });
  let calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  await dispatchWorkflow(config, "probe");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main", inputs: { probe_id: "probe", target_url: config.deploymentUrl } });
  assert.match(calls[0].url, /actions\/workflows\/turtl-probe.yml\/dispatches$/);
  const run = { id: 5, html_url: "https://github.com/owner/game/actions/runs/5", head_sha: sha, status: "completed", run_attempt: 1, display_title: "turtl-probe probe" };
  globalThis.fetch = async () => Response.json({ total_count: 2, workflow_runs: [{ ...run, id: 4, display_title: "unrelated" }, run] });
  assert.equal((await findWorkflowRun(config, "probe", Date.now())).id, 5);
  globalThis.fetch = async () => Response.json({ total_count: 2, workflow_runs: [run, run] });
  await assert.rejects(findWorkflowRun(config, "probe", Date.now()));
});

test("artifact redirects never forward the GitHub token to blob storage", async (t) => {
  process.env.PROBE_UNIT_TOKEN = "unit-test-only";
  const original = globalThis.fetch;
  t.after(() => { delete process.env.PROBE_UNIT_TOKEN; globalThis.fetch = original; });
  const bytes = archive();
  globalThis.fetch = async (url, init) => {
    if (url.includes("/artifacts?")) return Response.json({ total_count: 1, artifacts: [{ id: 7, name: "turtl-probe-probe", expired: false, size_in_bytes: bytes.length }] });
    if (url.includes("/zip")) return new Response(null, { status: 302, headers: { location: "https://unit.blob.core.windows.net/artifact?signature=unit" } });
    assert.equal(init.headers, undefined);
    return new Response(bytes);
  };
  assert.deepEqual(await downloadArtifact(config, 5, "probe"), bytes);
  assert.equal((await readRevision(config)).ok, false);
});

test("revision and sanitized diagnostics fail closed while optional diagnostics stay unavailable", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { delete process.env.PROBE_UNIT_TOKEN; globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ revision: sha, environment: "demo", ignored: "not persisted" });
  assert.deepEqual(await readRevision(config), { ok: true, body: { revision: sha, environment: "demo" } });
  assert.equal((await readDiagnostics(config)).ok, false);
  const diagnosticConfig = { ...config, diagnostics: { path: "/api/turtl/diagnostics", credentialRef: "PROBE_UNIT_TOKEN" } };
  process.env.PROBE_UNIT_TOKEN = "unit-test-only";
  const diagnostics = { revision: sha, environment: "demo", fixture: { id: "large-v1", scoreCount: 1_600_000 }, requestDeadlineMs: 2000, window: { since: 1000, until: 2000, truncated: false }, counts: { requests: 1, failedRequests: 1 }, events: [{ at: 1500, level: "error", route: "POST /api/answer", message: "Timed out.", token: "discard" }] };
  globalThis.fetch = async () => Response.json(diagnostics);
  const read = await readDiagnostics(diagnosticConfig);
  assert.equal(read.ok, true); assert.equal(read.body.events[0].token, undefined);
  diagnostics.events[0].route = "POST /api/answer?token=discard";
  assert.equal((await readDiagnostics(diagnosticConfig)).ok, false);
  await assert.rejects(readBytes(new Response(Buffer.alloc(100)), 99));
});

test("settlement is atomic and completion is scheduled once without mutating workflow steps", async () => {
  const run = { _id: "run", appId: "app", purpose: "monitor", config, deadlineAt: Date.now() + 60_000 };
  const scheduled = [], inserts = [];
  const ctx = { db: { get: async () => run, patch: async (_id, patch) => Object.assign(run, patch), insert: async (table, value) => inserts.push({ table, value }) }, scheduler: { runAfter: async (...args) => scheduled.push(args) } };
  const args = { probeRunId: "run", outcome: "passed", reason: "Unit test", result: result(), screenshots: [] };
  assert.equal(await records.complete._handler(ctx, args), true);
  assert.equal(await records.complete._handler(ctx, args), false);
  assert.equal(scheduled.length, 1);
  assert.equal(inserts.length, 0);
});

test("startProbe returns immediately after persistence and local ingestion is internal-only", async () => {
  const calls = [];
  const ctx = { runMutation: async (_ref, args) => { calls.push(args); return "run"; } };
  assert.equal(await startProbe(ctx, { externalApp: { ...config, _id: "external", _creationTime: 1 }, purpose: "monitor" }), "run");
  assert.equal(calls.length, 1); assert.equal(calls[0].transport, "github_actions");
  assert.equal(ingestArtifact.isInternal, true);
  assert.equal(records.uploadUrl.isInternal, true);
});
