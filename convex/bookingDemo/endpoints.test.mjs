import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// Runs convex/http.ts and the booking modules without a server: Convex is replaced by an in-memory store,
// and the simulated recommendation provider answers at once. control.test.mjs covers a real deployment.

const root = new URL("../../", import.meta.url);
const nodeRequire = createRequire(import.meta.url);
const token = "fixture-control-token";
const secretHash = createHash("sha256").update(token).digest("hex");
const configurations = [false, true].flatMap((recommendationsEnabled) => [false, true].flatMap((providerTimeout) => [false, true].map((bookingStoreFailure) => ({ recommendationsEnabled, providerTimeout, bookingStoreFailure }))));
const journeyKeys = ["cleanup", "completedAt", "environment", "error", "failedStep", "revision", "runId", "startedAt", "steps", "verdict"];

const refs = (path = []) => new Proxy({}, { get: (_, key) => (path.length === 2 ? `${path.join("/")}:${String(key)}` : refs([...path, key])) });

function app({ failing = [], replace = {} } = {}) {
  const routes = new Map();
  const logs = [];
  const modules = new Map();
  const imports = {
    "convex/server": { httpRouter: () => ({ route: ({ path, method, handler }) => routes.set(`${method} ${path}`, handler) }) },
    "convex/values": nodeRequire("convex/values"),
    _generated_server: Object.fromEntries(["httpAction", "action", "query", "internalAction", "internalQuery", "internalMutation"].map((name) => [name, (definition) => definition])),
    _generated_api: { api: refs(), internal: refs() },
    provider: { STAGED_TIMEOUT_MS: 1200, recommend: async (timeout) => { if (timeout) throw new Error("STAGED_PROVIDER_TIMEOUT"); return ["unwind", "reset"]; } },
  };
  const load = (url) => {
    if (modules.has(url)) return modules.get(url).exports;
    const module = { exports: {} };
    modules.set(url, module);
    const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    runInThisContext(`(function(require, exports, module, process, console) { ${outputText}\n})`, { filename: url })(
      (name) => {
        if (name in imports) return imports[name];
        const key = name.endsWith("_generated/server") ? "_generated_server" : name.endsWith("_generated/api") ? "_generated_api" : name.endsWith("/provider") ? "provider" : null;
        if (key) return imports[key];
        assert.ok(name.startsWith("."), `Unexpected import: ${name}`);
        return load(new URL(`${name}.ts`, url).href);
      },
      module.exports, module, { env: { PROTECTED_APP_CONTROL_SECRET_SHA256: secretHash } }, { error: (line) => logs.push(JSON.parse(line)) },
    );
    return module.exports;
  };
  load(new URL("convex/http.ts", root).href);
  const functions = {};
  for (const name of ["state", "records", "booking", "checks"]) {
    for (const [key, value] of Object.entries(load(new URL(`convex/bookingDemo/${name}.ts`, root).href))) functions[`bookingDemo/${name}:${key}`] = value;
  }
  Object.assign(functions, replace);

  const tables = new Map();
  let nextId = 0;
  const table = (name) => tables.get(name) ?? tables.set(name, new Map()).get(name);
  const db = {
    insert: async (name, doc) => { const _id = `${name}|${++nextId}`; table(name).set(_id, { _id, ...doc }); return _id; },
    get: async (id) => table(id.split("|")[0]).get(id) ?? null,
    patch: async (id, fields) => { Object.assign(table(id.split("|")[0]).get(id), fields); },
    delete: async (id) => { table(id.split("|")[0]).delete(id); },
    query: (name) => ({
      withIndex: (_index, range) => {
        const filters = [];
        const q = { eq: (field, value) => (filters.push((row) => row[field] === value), q), gte: (field, value) => (filters.push((row) => row[field] >= value), q), lte: (field, value) => (filters.push((row) => row[field] <= value), q) };
        range(q);
        let rows = [...table(name).values()].filter((row) => filters.every((keep) => keep(row)));
        const result = { order: (direction) => { if (direction === "desc") rows = rows.reverse(); return result; }, take: async (count) => rows.slice(0, count), collect: async () => rows, unique: async () => rows[0] ?? null };
        return result;
      },
    }),
  };
  const run = async (ref, args) => {
    if (failing.includes(ref)) throw new Error(`${ref} is unavailable`);
    assert.ok(functions[ref], `Unknown function: ${ref}`);
    return functions[ref].handler(ctx, args);
  };
  const ctx = { db, runQuery: run, runMutation: run, runAction: run };

  async function call(method, path, { body, auth = token } = {}) {
    const handler = routes.get(`${method} /booking-demo${path}`);
    assert.ok(handler, `No route for ${method} ${path}`);
    const headers = { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
    const response = await handler(ctx, new Request(`http://127.0.0.1:3211/booking-demo${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, json: await response.json() };
  }
  const stage = (configuration) => functions["bookingDemo/state:set"].handler(ctx, configuration);
  const rows = (name) => [...table(name).values()];
  return { call, stage, rows, routes, logs };
}

const step = (result, name) => result.json.steps.find((s) => s.step === name);

test("turtl.json lists every health, readiness, journey, flag and recovery route, and each answers as described", async () => {
  const manifest = JSON.parse(readFileSync(new URL("protected-app/turtl.json", root), "utf8"));
  const a = app();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.credentialRef, "PROTECTED_APP_CONTROL_SECRET");
  const listed = [
    { ...manifest.health, method: "GET", authenticated: false },
    { ...manifest.readiness, method: "GET" },
    ...manifest.journeys.map((j) => ({ ...j, method: "POST" })),
    ...[...manifest.flags, ...manifest.recoveryHooks].map((s) => ({ ...s, method: "GET" })),
  ];
  for (const entry of listed) {
    assert.ok(entry.name && entry.path.startsWith("/"), `${entry.path} needs a name and a relative path`);
    if (entry.authenticated) assert.equal((await a.call(entry.method, entry.path, { auth: null })).status, 401, `${entry.path} must refuse a missing secret`);
    assert.equal((await a.call(entry.method, entry.path, { auth: entry.authenticated ? token : null })).status, 200, `${entry.path} must answer`);
  }
  for (const s of [...manifest.flags, ...manifest.recoveryHooks]) {
    assert.equal(typeof (await a.call("GET", s.path)).json[s.field], "boolean");
    assert.equal((await a.call("POST", s.path, { body: { [s.field]: false } })).json[s.field], false);
    assert.equal((await a.call("POST", s.path, { body: { [s.field]: true } })).json[s.field], true);
  }
  const notForTurtl = ["GET /booking-demo/revision", "GET /booking-demo/errors", "GET /booking-demo/staged-failure", "POST /booking-demo/staged-failure", "POST /booking-demo/flags"];
  const mounted = [...a.routes.keys()].filter((key) => !notForTurtl.includes(key)).sort();
  assert.deepEqual([...new Set(listed.map((e) => `${e.method} /booking-demo${e.path}`))].sort(), mounted);
});

test("readiness answers 200 only when the store and every provider bookings wait for answer, without a secret or any writes", async () => {
  for (const configuration of configurations) {
    const a = app();
    await a.stage(configuration);
    const result = await a.call("GET", "/ready", { auth: null });
    const failing = configuration.bookingStoreFailure ? { dependency: "booking_store", code: "BOOKING_STORE_UNAVAILABLE" } : configuration.recommendationsEnabled && configuration.providerTimeout ? { dependency: "recommendations_provider", code: "RECOMMENDATIONS_TIMEOUT" } : null;
    const label = JSON.stringify(configuration);
    assert.equal(result.status, failing ? 503 : 200, label);
    assert.equal(result.json.ready, !failing, label);
    assert.match(result.json.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(result.json.failing && { dependency: result.json.failing.dependency, code: result.json.failing.code }, failing, label);
    assert.equal(result.json.dependencies.find((d) => d.dependency === "recommendations_provider").status, !configuration.recommendationsEnabled ? "not_required" : configuration.providerTimeout ? "failed" : "ok", label);
    assert.deepEqual(a.logs, failing ? [{ event: "readiness_failed", requestId: result.json.requestId, ...failing }] : [], label);
    assert.deepEqual([a.rows("bookingDemoBookings").length, a.rows("bookingDemoAttempts").length], [0, 0], "Readiness must not write bookings or attempts");
  }
});

test("readiness names the booking store when the database does not answer", async () => {
  const a = app({ failing: ["bookingDemo/state:read"] });
  const result = await a.call("GET", "/ready", { auth: null });
  assert.equal(result.status, 503);
  assert.deepEqual(result.json.failing, { dependency: "booking_store", code: "BOOKING_STORE_UNAVAILABLE", message: "The booking database did not answer." });
  assert.equal(result.json.dependencies.find((d) => d.dependency === "recommendations_provider").status, "not_checked");
  assert.equal(a.logs[0].requestId, result.json.requestId);
});

test("all three journeys keep their verdicts across the eight staged configurations, clean up, and never count as customers", async () => {
  for (const configuration of configurations) {
    const a = app();
    await a.stage(configuration);
    const label = JSON.stringify(configuration);
    const bookingFails = configuration.bookingStoreFailure ? "submit_booking" : configuration.recommendationsEnabled && configuration.providerTimeout ? "recommendations" : null;
    const offFails = configuration.bookingStoreFailure ? "submit_booking" : null;
    for (const [path, journey, failedStep, keys] of [["/journey-check", "booking", bookingFails, [...journeyKeys, "configuration"].sort()], ["/journey-check/catalog", "catalog", null, journeyKeys], ["/journey-check/recommendations-off", "booking_without_recommendations", offFails, journeyKeys]]) {
      const result = await a.call("POST", path);
      assert.deepEqual(Object.keys(result.json).sort(), keys, `${path} ${label}`);
      assert.equal(result.status, failedStep ? 503 : 200, `${path} ${label}`);
      assert.equal(result.json.verdict, failedStep ? "failed" : "passed", `${path} ${label}`);
      assert.equal(result.json.failedStep, failedStep, `${path} ${label}`);
      assert.equal(result.json.error?.step ?? null, failedStep, `${path} ${label}`);
      if (failedStep) {
        assert.equal(result.json.error.code, failedStep === "recommendations" ? "RECOMMENDATIONS_TIMEOUT" : "BOOKING_STORE_UNAVAILABLE");
        assert.deepEqual(a.logs.at(-1), { event: "journey_check_failed", journey, runId: result.json.runId, code: result.json.error.code, step: failedStep });
      }
      assert.deepEqual(result.json.cleanup, { ok: true, deletedBookings: failedStep || path.endsWith("/catalog") ? 0 : 1 }, `${path} ${label}`);
      assert.equal(step(result, "cleanup").verdict, "passed");
      assert.equal(result.json.environment, "protected-app");
      assert.ok(result.json.completedAt >= result.json.startedAt);
    }
    assert.deepEqual(a.rows("bookingDemoBookings"), [], "Every fixture booking is deleted");
    assert.deepEqual(a.rows("bookingDemoAttempts"), [], "Fixture runs never record customer attempts");
    assert.deepEqual((await a.call("GET", "/errors")).json.counts, { totalBookings: 0, failedBookings: 0, successfulBookings: 0, errorRate: 0 });
  }
});

test("the recommendations-off journey proves the recovery path without touching the live switch", async () => {
  const a = app();
  await a.stage({ recommendationsEnabled: true, providerTimeout: true, bookingStoreFailure: false });
  assert.equal((await a.call("POST", "/journey-check")).status, 503);
  const result = await a.call("POST", "/journey-check/recommendations-off");
  assert.equal(result.status, 200);
  assert.deepEqual(step(result, "recommendations"), { step: "recommendations", verdict: "skipped", detail: "Recommendations were off for this check only, so the provider was not called; the live setting stayed on." });
  assert.equal(step(result, "verify_persisted").verdict, "passed");
  assert.equal((await a.call("GET", "/flags")).json.recommendationsEnabled, true);
});

test("the catalog journey reports a stable code at the step customers would get stuck on", async () => {
  for (const [options, failedStep, code] of [
    [{ failing: ["bookingDemo/booking:getCatalog"] }, "load_catalog", "CATALOG_UNAVAILABLE"],
    [{ replace: { "bookingDemo/booking:getCatalog": { handler: () => ({ services: [], slots: ["09:00"], date: "2999-01-01", timezone: "UTC" }) } } }, "check_catalog", "CATALOG_INCOMPLETE"],
    [{ replace: { "bookingDemo/booking:getCatalog": { handler: () => ({ services: [{ id: "reset", name: "The reset", minutes: 30, price: 55 }], slots: ["09:00"], date: "2000-01-01", timezone: "UTC" }) } } }, "check_catalog", "CATALOG_INCOMPLETE"],
    [{ failing: ["bookingDemo/booking:getFlags"] }, "load_flags", "FLAGS_UNAVAILABLE"],
    [{ failing: ["bookingDemo/records:cleanup"] }, "cleanup", "CLEANUP_FAILED"],
  ]) {
    const a = app(options);
    const result = await a.call("POST", "/journey-check/catalog");
    assert.equal(result.status, 503, code);
    assert.equal(result.json.failedStep, failedStep);
    assert.equal(result.json.error.code, code);
    assert.equal(result.json.error.step, failedStep);
    assert.equal(step(result, failedStep).verdict, "failed");
    assert.equal(result.json.cleanup.ok, code !== "CLEANUP_FAILED");
    assert.deepEqual(a.logs, [{ event: "journey_check_failed", journey: "catalog", runId: result.json.runId, code, step: failedStep }]);
  }
});

test("a booking journey whose fixture cannot be cleaned up is not a pass", async () => {
  const a = app({ failing: ["bookingDemo/records:cleanup"] });
  const result = await a.call("POST", "/journey-check/recommendations-off");
  assert.equal(result.status, 503);
  assert.deepEqual([result.json.failedStep, result.json.error.code, result.json.cleanup.ok], ["cleanup", "CLEANUP_FAILED", false]);
});

test("journeys, flags and the recovery hook refuse a wrong or missing secret, and the switch accepts exactly one boolean", async () => {
  const a = app();
  for (const path of ["/journey-check", "/journey-check/catalog", "/journey-check/recommendations-off"]) {
    assert.equal((await a.call("POST", path, { auth: null })).status, 401);
    assert.equal((await a.call("POST", path, { auth: "deliberately-invalid-token" })).status, 401);
    assert.equal((await a.call("POST", path, { auth: secretHash })).status, 401, "The stored hash must not authenticate");
  }
  assert.equal((await a.call("GET", "/flags", { auth: "deliberately-invalid-token" })).status, 401);
  assert.equal((await a.call("POST", "/flags", { body: { recommendationsEnabled: false }, auth: null })).status, 401);
  assert.equal((await a.call("POST", "/flags", { body: { recommendationsEnabled: false, extra: true } })).status, 400);
  assert.equal((await a.call("POST", "/flags", { body: { unknownSwitch: false } })).status, 400);
  assert.equal((await a.call("POST", "/flags", { body: { recommendationsEnabled: "false" } })).status, 400);
  assert.deepEqual(a.rows("bookingDemoBookings"), []);
  assert.equal((await a.call("GET", "/flags")).json.recommendationsEnabled, true);
});
