import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createBackend, createLoader } from "./fixtures/convex-backend.mjs";

// What turtl does with each check it registered for a project. Two things this file holds:
//
// 1. A health or readiness check is sent as what it is, a GET, and read as what it is: a health check passes on a 200,
//    a readiness check says "not ready" with a 503 that has a body. Before, the monitor sent every row a POST under the
//    journey contract, so these two never gave a result and read "Passed" from the day they were registered.
// 2. A check that turtl.json no longer lists is retired when registration runs again: not sent, not shown, not
//    counted. Before, registration only ever added rows.
//
// Each test runs the real monitor and the real registration (convex/monitor.ts, convex/protectedApp/,
// convex/onboarding/) on an in-memory copy of every table, minute by minute, against stand-ins for the owner's app and
// for GitHub. The rules are named as in the design (P1 to P7, T1 to T9).

const KEY = randomBytes(32).toString("base64");
const ACCOUNTS = { AUTH_REQUIRED: "true", SECRETS_ENCRYPTION_KEY: KEY };
const VARIABLES = [
  "AUTH_REQUIRED", "SECRETS_ENCRYPTION_KEY", "PROTECTED_APP_URL", "PROTECTED_APP_CONTROL_SECRET", "CONVEX_SITE_URL", "CONVEX_CLOUD_URL",
  "WATCHED_APP_ALLOW_LOOPBACK", "KEIKI_API_KEY", "KEIKI_AGENT_ID", "KEIKI_OWNER_CONTACT", "OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_API_URL", "CAPY_API_KEY",
  "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET",
];
const START = Date.parse("2026-11-16T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (minute) => START + minute * MINUTE;
const HOST = "shop.example";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const passed = { runId: "run-1", verdict: "passed", failedStep: null, error: null, steps: [], cleanup: { ok: true, deletedBookings: 0 }, revision: "abc1234", environment: "test", startedAt: 1, completedAt: 2 };
const failed = { ...passed, verdict: "failed", failedStep: "save_booking", error: { code: "STORE_DOWN", message: "The store is down." } };
const down = () => {
  throw new TypeError("fetch failed");
};
const badGateway = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
/** What a health route answers: 200, and nothing that looks like a check result. */
const healthy = () => json({ ok: true, service: "shop" });
/** What a readiness route answers when the app cannot serve customers: 503, with a body that says why. */
const notReady = () => json({ ready: false, waitingFor: "database" }, 503);

/** A stand-in for every outside address: `route(host)` answers, and every request is recorded with its method. */
function network(t, route) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    sent.push({ host: target.host, path: target.pathname, method: init.method ?? "GET", body: init.body, authorization: init.headers?.Authorization, at: Date.now() });
    return (route(target.host) ?? (() => json({ ok: true })))(target, init);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

function world(t, env = ACCOUNTS) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
  t.after(() => {
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const load = createLoader({
    // An ordinary case the monitor opens is a row; the rest of its incident run is not under test here.
    "convex/runner/run": {
      startCaseRun: async (ctx, args) => ctx.db.insert("cases", { appId: args.appId, journeyId: args.journeyId, title: args.title, impact: args.impact, kind: args.kind, raisedBy: args.raisedBy, status: "investigating", signature: args.signature }),
      approveCase: async () => {},
      declineCase: async () => {},
    },
  });
  const backend = createBackend(load);
  const seen = new Set();
  const push = backend.scheduled.push.bind(backend.scheduled);
  backend.scheduled.push = (...jobs) => {
    for (const job of jobs) seen.add(job);
    return push(...jobs);
  };
  return { load, seen, ...backend };
}

const MANIFEST_VERSION = "onboarding-manifest-v1:abcdef123456";
const journeyCheck = (path) => ({ kind: "http", config: { url: `https://${HOST}${path}`, method: "POST", expectedStatus: 200 } });
const probeCheck = (path) => ({ kind: "http", config: { url: `https://${HOST}${path}`, method: "GET", expectedStatus: 200 } });

/** A project on its own https origin, with an owner. */
async function shop(w, name = "Shop") {
  const owner = await w.db.insert("users", { email: `${name.toLowerCase()}@example.com` });
  const appId = await w.db.insert("apps", { name, ownerId: owner, repoUrl: "https://github.com/o/shop", productionUrl: `https://${HOST}` });
  return { owner, appId };
}
/** A journey check as registration writes it. `passed`: it passed an hour before the test starts. */
const journey = (w, appId, name, path, { passed: before = true } = {}) =>
  w.db.insert("journeys", { appId, name, description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck(path), ...(before && { lastPassedAt: START - HOUR }) });
/** A health or readiness check as registration writes it (a test below holds registration to this shape). */
const probe = (w, appId, kind, { passed: before = true, name = kind === "health" ? "Server answers" : "Ready to take bookings", path = kind === "health" ? "/health" : "/ready" } = {}) =>
  w.db.insert("journeys", { appId, name, description: ".", checkVersion: MANIFEST_VERSION, check: probeCheck(path), probe: kind, ...(before && { lastPassedAt: START - HOUR }) });

const RUNS = ["internal.monitor.checkProject", "internal.notices.notifyOwner", "internal.protectedApp.notAnswering.stopped", "internal.onboarding.prepare.register"];

/** Runs the monitor's cron once a minute from `from` to `to`, every scheduled check and notice to completion. */
async function minutes(t, w, from, to) {
  for (let minute = from; minute < to; minute++) {
    t.mock.timers.setTime(at(minute));
    await w.run("internal.monitor.tick", {});
    await w.drain(RUNS);
  }
}

/**
 * Runs the monitor minute by minute from `from` until a not-answering case exists, and returns the minute after it
 * opened. A project that keeps failing the same way is checked after one minute, then two, so the third try in a row
 * comes three minutes after the first. Before every check that decides has three, nothing may be open.
 */
async function untilCase(t, w, from, { within = 8 } = {}) {
  for (let minute = from; minute < from + within; minute++) {
    await minutes(t, w, minute, minute + 1);
    if (notAnswering(w).length) return minute + 1;
    assert.deepEqual(pushes(w).filter((event) => event === "not_answering"), [], "no push before the case");
  }
  assert.fail(`no not-answering case within ${within} minutes`);
}

const flush = async (times = 20) => {
  for (let n = 0; n < times; n++) await new Promise((resolve) => setImmediate(resolve));
};

/** Takes the round a tick scheduled and starts it without waiting for it: a round in flight. */
async function startRound(w) {
  await w.run("internal.monitor.tick", {});
  const index = w.scheduled.findIndex((job) => job.path === "internal.monitor.checkProject");
  assert.ok(index >= 0, "the tick started a round");
  const [job] = w.scheduled.splice(index, 1);
  const running = w.run(job.path, job.args);
  await flush();
  // Wrapped: an async function returning the promise itself would wait for the round.
  return { running };
}

const row = (w, id) => w.rows("journeys").find((one) => one._id === id);
const notAnswering = (w) => w.rows("cases").filter((one) => one.signature?.startsWith("not_answering:"));
const ordinary = (w) => w.rows("cases").filter((one) => one.signature?.startsWith("journey_failed:"));
const pushes = (w) => [...w.seen].filter((job) => job.path === "internal.push.deliver.forNotice").map((job) => job.args.event);
const count = (w, id) => row(w, id).unanswered?.count ?? 0;
const overview = async (w, appId, owner) => (await w.run("api.screens.overview.forProject", { projectId: appId }, owner)).checks;
const shown = async (w, appId, owner) => Object.fromEntries((await overview(w, appId, owner)).map((check) => [check.name, check]));
const closing = (w, caseId) => w.rows("stepAttempts").find((one) => one.caseId === caseId);
const CANNOT_TELL = "turtl closed this case because it can no longer tell whether the app answers: its checks no longer get a reply turtl can read.";

// =====================================================================================================================
// Part 1: health and readiness checks
// =====================================================================================================================

test("P2: a probe is a GET with no body; a health check passes on a 200 and on nothing else; a readiness check is not ready on a 503 with a body", async (t) => {
  const client = createLoader()("convex/protectedApp/client.ts");
  const app = { refuse: () => null, token: async () => ({ ok: true, token: "the-token" }), followRedirects: false };
  let answer = () => assert.fail("nothing is sent");
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => (sent.push({ url: String(url), method: init.method, body: init.body, authorization: init.headers.Authorization }), answer(init)));
  const health = { url: "https://shop.example/health", probe: "health" };
  const readiness = { url: "https://shop.example/ready", probe: "readiness" };

  answer = healthy;
  assert.equal((await client.runProbe(health, app)).kind, "passed");
  assert.deepEqual(sent.at(-1), { url: "https://shop.example/health", method: "GET", body: undefined, authorization: undefined }, "a GET, with no body and no token unless the check names one");
  answer = () => new Response("ok", { status: 200 });
  assert.equal((await client.runProbe(health, app)).kind, "passed", "a 200 passes whatever its body");
  assert.equal((await client.runProbe(readiness, app)).kind, "passed");
  await client.runProbe({ ...health, credentialRef: client.CREDENTIAL_REF }, app);
  assert.equal(sent.at(-1).authorization, "Bearer the-token", "an authenticated probe carries the project's token");

  // Not ready: only a readiness check, only a 503, only with a JSON body.
  answer = notReady;
  assert.deepEqual(await client.runProbe(readiness, app), { kind: "not_ready", reason: "the app said it is not ready to serve customers (HTTP 503)" });
  assert.deepEqual(await client.runProbe(health, app), { kind: "no_result", status: 503, reason: "the health check returned HTTP 503" }, "a health check has no such answer");
  answer = () => new Response("Service Unavailable", { status: 503 });
  assert.deepEqual(await client.runProbe(readiness, app), { kind: "no_result", status: 503, reason: "the readiness check returned HTTP 503" }, "a 503 with no body is a host's error page");
  answer = () => json({ ready: false }, 500);
  assert.equal((await client.runProbe(readiness, app)).kind, "no_result", "only a 503");

  // Any other reply is one turtl cannot read.
  for (const [status, reply] of [[204, () => new Response(null, { status: 204 })], [404, () => new Response("Not Found", { status: 404 })], [401, () => json({ error: "no" }, 401)], [302, () => new Response("", { status: 302, headers: { Location: "https://login.example/" } })]]) {
    answer = reply;
    assert.deepEqual([(await client.runProbe(health, app)).kind, (await client.runProbe(health, app)).status], ["no_result", status]);
  }
  answer = down;
  assert.deepEqual(await client.runProbe(health, app), { kind: "no_response", timedOut: false, reason: "the request failed (TypeError)" });
  const refused = await client.runProbe(health, { ...app, refuse: () => "turtl sends this project's requests only to its own address, so it sent nothing" });
  assert.equal(refused.kind, "not_sent");
});

test("P1, P3: the monitor sends a health and a readiness check as GETs, each pass moves when it last passed, and a healthy round settles nothing", async (t) => {
  const w = world(t);
  const sent = network(t, (host) => (host === HOST ? (target) => (target.pathname === "/journey-check" ? json(passed) : healthy()) : null));
  const { owner, appId } = await shop(w);
  await journey(w, appId, "Book an appointment", "/journey-check");
  const health = await probe(w, appId, "health");
  const ready = await probe(w, appId, "readiness");
  w.reads.length = 0;
  await minutes(t, w, 0, 5);
  const methods = Object.fromEntries(sent.filter((request) => request.host === HOST).map((request) => [request.path, request.method]));
  assert.deepEqual(methods, { "/journey-check": "POST", "/health": "GET", "/ready": "GET" });
  assert.ok(sent.filter((request) => request.method === "GET" && request.host === HOST).every((request) => request.body === undefined), "a GET carries no body");
  assert.deepEqual([row(w, health).lastPassedAt, row(w, ready).lastPassedAt], [at(4), at(4)], "not the hour-old time registration wrote");
  assert.deepEqual([notAnswering(w), ordinary(w), pushes(w)], [[], [], []]);
  assert.deepEqual(w.reads.filter(([table]) => table === "cases"), [], "a healthy round reads no case");
  const checks = await overview(w, appId, owner);
  assert.deepEqual(checks.map((check) => [check.name, check.kind, check.state, check.lastPassedAt]), [
    ["Book an appointment", "journey", "passing", at(4)],
    ["Server answers", "health", "passing", at(4)],
    ["Ready to take bookings", "readiness", "passing", at(4)],
  ]);
});

test("P1: a GET check from before turtl kept which probe it is, is sent as a GET and read as a health check", async (t) => {
  const w = world(t);
  const sent = network(t, (host) => (host === HOST ? healthy : null));
  const { appId } = await shop(w);
  const old = await w.db.insert("journeys", { appId, name: "Health", description: ".", checkVersion: MANIFEST_VERSION, check: probeCheck("/health"), lastPassedAt: START - HOUR });
  await minutes(t, w, 0, 2);
  assert.deepEqual(sent.filter((request) => request.host === HOST).map((request) => request.method), ["GET", "GET"]);
  assert.equal(row(w, old).lastPassedAt, at(1));
});

test("P3, P5: beside a journey check that passes, a probe that goes quiet shows nothing for two rounds and then reads Not answering or Not ready; no case, no push", async (t) => {
  const w = world(t);
  let health = healthy;
  let ready = healthy;
  network(t, (host) => (host === HOST ? (target) => (target.pathname === "/health" ? health() : target.pathname === "/ready" ? ready() : json(passed)) : null));
  const { owner, appId } = await shop(w);
  await journey(w, appId, "Book an appointment", "/journey-check");
  const healthId = await probe(w, appId, "health");
  const readyId = await probe(w, appId, "readiness");
  await minutes(t, w, 0, 2);

  health = badGateway;
  ready = notReady;
  await minutes(t, w, 2, 4);
  assert.deepEqual([count(w, healthId), count(w, readyId)], [2, 2]);
  let checks = await shown(w, appId, owner);
  assert.deepEqual([checks["Server answers"].state, checks["Ready to take bookings"].state], ["passing", "passing"], "two tries in a row show nothing");
  assert.equal(checks["Server answers"].lastPassedAt, at(1), "and it says when it really last passed");

  await minutes(t, w, 4, 30);
  checks = await shown(w, appId, owner);
  assert.equal(checks["Server answers"].state, "failing");
  assert.deepEqual(checks["Server answers"].notAnswering, { since: at(2), tries: 28 });
  assert.equal(checks["Ready to take bookings"].state, "failing");
  assert.deepEqual(checks["Ready to take bookings"].notAnswering, { since: at(2), tries: 28, notReady: true });
  assert.equal(checks["Book an appointment"].state, "passing");
  assert.deepEqual(row(w, readyId).unanswered.latest, { kind: "not_ready" });
  // Nothing else: the journey check gives a result, so the app is serving, and a probe opens no case of its own.
  assert.deepEqual([notAnswering(w), ordinary(w), pushes(w), w.rows("ownerNotices")], [[], [], [], []]);

  health = healthy;
  ready = healthy;
  await minutes(t, w, 30, 31);
  checks = await shown(w, appId, owner);
  assert.deepEqual([checks["Server answers"].state, checks["Ready to take bookings"].state, count(w, healthId), count(w, readyId)], ["passing", "passing", 0, 0]);
});

test("P2: a probe whose route now answers 404, 401 or a redirect keeps no count and opens nothing, in either kind of project", async (t) => {
  for (const [what, reply] of [["404", () => new Response("Not Found", { status: 404 })], ["401", () => json({ error: "no" }, 401)], ["a redirect", () => new Response("", { status: 302, headers: { Location: "https://login.example/" } })]]) {
    for (const withJourney of [true, false]) {
      await t.test(`${what}, ${withJourney ? "beside a journey check" : "alone"}`, async (t) => {
        const w = world(t);
        network(t, (host) => (host === HOST ? (target) => (target.pathname === "/health" ? reply() : json(passed)) : null));
        const { owner, appId } = await shop(w);
        if (withJourney) await journey(w, appId, "Book an appointment", "/journey-check");
        const health = await probe(w, appId, "health");
        await minutes(t, w, 0, 30);
        assert.deepEqual([count(w, health), notAnswering(w), pushes(w)], [0, [], []]);
        const checks = await shown(w, appId, owner);
        assert.deepEqual([checks["Server answers"].state, checks["Server answers"].lastPassedAt], ["passing", START - HOUR], "it goes on showing when it last passed");
      });
    }
  }
});

test("P3: a readiness check that has never said ready keeps no count and opens nothing, however long", async (t) => {
  const w = world(t);
  network(t, (host) => (host === HOST ? notReady : null));
  const { owner, appId } = await shop(w);
  const ready = await probe(w, appId, "readiness", { passed: false });
  await minutes(t, w, 0, 30);
  assert.deepEqual([row(w, ready).unanswered, notAnswering(w), ordinary(w), pushes(w)], [undefined, [], [], []]);
  assert.equal((await shown(w, appId, owner))["Ready to take bookings"].state, "waiting");
});

test("P4: a project with only a health and a readiness check is told when its app stops answering, and again when it answers", async (t) => {
  const w = world(t);
  let up = true;
  network(t, (host) => (host === HOST ? () => (up ? healthy() : down()) : null));
  const { owner, appId } = await shop(w);
  const health = await probe(w, appId, "health");
  const ready = await probe(w, appId, "readiness");
  await minutes(t, w, 0, 3);
  assert.deepEqual([notAnswering(w), pushes(w)], [[], []]);

  up = false;
  await minutes(t, w, 3, 5);
  assert.deepEqual([count(w, health), count(w, ready), notAnswering(w), pushes(w)], [2, 2, [], []], "two rounds with no answer do nothing the owner can see");
  const openedBy = await untilCase(t, w, 5);
  assert.ok(openedBy <= 7, "about three minutes after it stopped answering");
  const [opened, ...more] = notAnswering(w);
  assert.deepEqual(more, []);
  assert.deepEqual([opened.status, opened.kind, opened.raisedBy, opened.journeyId, opened.title], ["waiting_for_app", "outage", "monitor", undefined, "Your app stopped answering"]);
  assert.equal(opened.impact, 'At least three tries in a row of each of 2 checks ("Server answers" and "Ready to take bookings") got no usable answer: turtl could not connect to the app.');
  assert.deepEqual(pushes(w), ["not_answering"]);
  const checks = await shown(w, appId, owner);
  assert.deepEqual([checks["Server answers"].state, checks["Server answers"].notAnswering.tries], ["failing", 3]);

  await minutes(t, w, openedBy, 40);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w), ordinary(w)], [["waiting_for_app"], ["not_answering"], []], "one case, one push, and never an ordinary case");

  up = true;
  await minutes(t, w, 40, 60);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w)], [["resolved"], ["not_answering", "answering_again"]]);
  assert.match(closing(w, opened._id).summary, /^The app answered turtl's checks again after about .* Its checks pass now\.$/);
  assert.deepEqual(closing(w, opened._id).output.allPassed, true);
  assert.deepEqual([count(w, health), count(w, ready)], [0, 0]);
});

test("P4: a readiness-only project whose app says it is not ready three times in a row gets the case, in those words", async (t) => {
  const w = world(t);
  let ready = healthy;
  network(t, (host) => (host === HOST ? () => ready() : null));
  const { owner, appId } = await shop(w);
  await probe(w, appId, "readiness");
  await minutes(t, w, 0, 2);
  ready = notReady;
  const openedBy = await untilCase(t, w, 2);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  assert.equal(opened.impact, 'At least three tries in a row of the "Ready to take bookings" check got no usable answer: the app said it is not ready to serve customers.');
  assert.deepEqual((await shown(w, appId, owner))["Ready to take bookings"].notAnswering, { since: at(2), tries: 3, notReady: true });
  ready = healthy;
  await minutes(t, w, openedBy, 25);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w)], [["resolved"], ["not_answering", "answering_again"]]);
});

test("P4: in a probe-only project, a readiness check that says not ready while the health check passes shows on the project and opens nothing", async (t) => {
  const w = world(t);
  network(t, (host) => (host === HOST ? (target) => (target.pathname === "/ready" ? notReady() : healthy()) : null));
  const { owner, appId } = await shop(w);
  await probe(w, appId, "health");
  const ready = await probe(w, appId, "readiness");
  await minutes(t, w, 0, 30);
  assert.deepEqual([notAnswering(w), ordinary(w), pushes(w)], [[], [], []]);
  assert.equal(count(w, ready), 30);
  const checks = await shown(w, appId, owner);
  assert.deepEqual([checks["Server answers"].state, checks["Ready to take bookings"].state, checks["Ready to take bookings"].notAnswering.notReady], ["passing", "failing", true]);
});

test("P4, H1a: beside a journey check that has passed, a health check's 200 neither stops the case from opening nor closes it", async (t) => {
  const w = world(t);
  let backendDown = false;
  // nginx answers /health by itself, whether or not the app behind it is there; a gateway answers /ready for it.
  network(t, (host) => (host === HOST ? (target) => (target.pathname === "/health" ? new Response("ok", { status: 200 }) : backendDown ? badGateway() : target.pathname === "/ready" ? healthy() : json(passed)) : null));
  const { owner, appId } = await shop(w);
  const book = await journey(w, appId, "Book an appointment", "/journey-check");
  const health = await probe(w, appId, "health");
  await probe(w, appId, "readiness");
  await minutes(t, w, 0, 2);
  backendDown = true;
  const openedBy = await untilCase(t, w, 2);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app", "the proxy's 200 did not stop it");
  assert.equal(opened.impact, 'At least three tries in a row of the "Book an appointment" check got no usable answer: the app replied with HTTP 502 but no check result.');
  assert.ok(row(w, health).lastPassedAt >= at(4), "the health check went on passing all the while");
  await minutes(t, w, openedBy, 6 * 60);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w)], [["waiting_for_app"], ["not_answering"]], "nor did it close the case, in six hours");
  assert.equal((await shown(w, appId, owner))["Server answers"].state, "passing", "the project shows the health check as it is");
  backendDown = false;
  await minutes(t, w, 6 * 60, 6 * 60 + 20);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w), count(w, book)], [["resolved"], ["not_answering", "answering_again"], 0]);
});

test("P4: beside a journey check that has passed, a quiet probe never opens the case, even when the journey check gives turtl nothing it can read", async (t) => {
  const w = world(t);
  let book = () => json(passed);
  network(t, (host) => (host === HOST ? (target) => (target.pathname === "/journey-check" ? book() : down()) : null));
  const { owner, appId } = await shop(w);
  await journey(w, appId, "Book an appointment", "/journey-check");
  const health = await probe(w, appId, "health");
  await minutes(t, w, 0, 30);
  assert.deepEqual([notAnswering(w), pushes(w)], [[], []], "the journey check gives a result");
  assert.ok(count(w, health) >= 3);
  assert.equal((await shown(w, appId, owner))["Server answers"].state, "failing");
  // The token was rotated: the journey check answers 401, which turtl cannot read. The health check is still quiet.
  book = () => json({ error: { code: "UNAUTHORIZED" } }, 401);
  await minutes(t, w, 30, 90);
  assert.deepEqual([notAnswering(w), pushes(w)], [[], []], "a journey project is not decided by its health check");
});

test("P4, K2: a journey project's open case closes as turtl no longer able to tell, never as answered, when only its health check can be read", async (t) => {
  const w = world(t);
  let mode = "down";
  network(t, (host) => (host === HOST ? (target) => (mode === "down" ? down() : target.pathname === "/health" ? healthy() : json({ error: { code: "UNAUTHORIZED" } }, 401)) : null));
  const { appId } = await shop(w);
  await journey(w, appId, "Book an appointment", "/journey-check");
  await probe(w, appId, "health");
  await minutes(t, w, 0, 4);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  // The app is back behind a rotated token: the journey check answers 401, the health check 200.
  mode = "rotated";
  await minutes(t, w, 4, 30);
  assert.deepEqual(notAnswering(w).map((one) => one.status), ["unresolved"]);
  assert.equal(closing(w, opened._id).summary, CANNOT_TELL);
  assert.deepEqual(pushes(w), ["not_answering"], "no 'answering again' on a health check's word");
});

test("P4: journey checks that have never passed do not make a journey project: its probes decide, and stop deciding once a journey check has passed", async (t) => {
  const w = world(t);
  let up = true;
  // The journey check's address is wrong: it has never passed and never answers.
  network(t, (host) => (host === HOST ? (target) => (target.pathname === "/journey-check" || !up ? down() : healthy()) : null));
  const { appId } = await shop(w);
  const book = await journey(w, appId, "Book an appointment", "/journey-check", { passed: false });
  const health = await probe(w, appId, "health");
  await minutes(t, w, 0, 30);
  assert.deepEqual([notAnswering(w), count(w, book)], [[], 0], "a check that has never passed still counts for nothing");
  up = false;
  await untilCase(t, w, 30);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  assert.equal(opened.impact, 'At least three tries in a row of the "Server answers" check got no usable answer: turtl could not connect to the app.');

  // A second project in the same state, at the moment the decision is made: the journey check passes for the first
  // time between the round that would open the case and the opening itself. The opening decides again, and refuses.
  const other = await w.db.insert("apps", { name: "Other", ownerId: (await shop(w, "Other")).owner, productionUrl: "https://other.example" });
  const otherBook = await w.db.insert("journeys", { appId: other, name: "Book", description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck("/journey-check") });
  const otherHealth = await w.db.insert("journeys", { appId: other, name: "Health", description: ".", checkVersion: MANIFEST_VERSION, check: probeCheck("/health"), probe: "health", lastPassedAt: START - HOUR, unanswered: { count: 2, since: at(31), at: at(32), latest: { kind: "no_response", timedOut: false } } });
  const settled = await w.run("internal.protectedApp.notAnswering.settle", { appId: other, tries: [{ journeyId: otherHealth, at: at(50), got: { kind: "no_response", timedOut: false } }, { journeyId: otherBook, at: at(50), got: { kind: "no_response", timedOut: false } }] });
  assert.equal(settled.kind, "would_open");
  await w.db.patch(otherBook, { lastPassedAt: at(50) + 1 });
  assert.equal(await w.run("internal.protectedApp.notAnswering.open", { appId: other, ran: settled.ran, turtl: "reachable" }), null, "a journey check has passed since: the health check no longer decides");
  assert.deepEqual(notAnswering(w).filter((one) => one.appId === other), []);
  void health;
});

test("P4: a never-passed journey check that returns a result is still a result in a probe-only project: no case while it answers, and it closes one", async (t) => {
  const w = world(t);
  let book = down;
  network(t, (host) => (host === HOST ? (target) => (target.pathname === "/journey-check" ? book() : down()) : null));
  const { appId } = await shop(w);
  await journey(w, appId, "Book an appointment", "/journey-check", { passed: false });
  await probe(w, appId, "health");
  await minutes(t, w, 0, 4);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app", "the health check alone decided");
  // The app's own code answers the journey check with a failing result: the app is serving.
  book = () => json(failed, 503);
  await minutes(t, w, 4, 25);
  assert.deepEqual(notAnswering(w).map((one) => one.status), ["resolved"]);
  assert.equal(ordinary(w).length, 1, "and the failing check opens its ordinary case, as it always has");
  await minutes(t, w, 25, 60);
  assert.equal(notAnswering(w).length, 1, "no new case while a check gives a result");
});

test("P6: a passing health check beside a journey check that keeps failing the same way does not put the project back to every minute", async (t) => {
  const w = world(t);
  const sent = network(t, (host) => (host === HOST ? (target) => (target.pathname === "/journey-check" ? json(failed, 503) : healthy()) : null));
  const { appId } = await shop(w);
  await journey(w, appId, "Book an appointment", "/journey-check");
  await probe(w, appId, "health");
  await minutes(t, w, 0, 60);
  const rounds = sent.filter((request) => request.path === "/journey-check").length;
  assert.ok(rounds <= 12, `checked ${rounds} times in an hour while failing the same way`);
  assert.ok(w.rows("watchedProjects")[0].failure.streak >= 5);
});

test("P6: a healthy project with only probes is checked every minute, not spaced out as if it kept failing", async (t) => {
  const w = world(t);
  const sent = network(t, (host) => (host === HOST ? healthy : null));
  const { appId } = await shop(w);
  await probe(w, appId, "health");
  await probe(w, appId, "readiness");
  await minutes(t, w, 0, 30);
  assert.equal(sent.filter((request) => request.path === "/health").length, 30);
  assert.equal(w.rows("watchedProjects")[0].failure, undefined);
});

test("P4, R9: the single-owner demo follows the same rules", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: `https://${HOST}`, PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  let up = true;
  const sent = network(t, (host) => (host === HOST ? () => (up ? healthy() : down()) : null));
  const appId = await w.db.insert("apps", { name: "Demo shop", productionUrl: `https://${HOST}` });
  const health = await probe(w, appId, "health");
  await minutes(t, w, 0, 3);
  assert.deepEqual([sent.filter((request) => request.host === HOST).map((request) => request.method), row(w, health).lastPassedAt], [["GET", "GET", "GET"], at(2)]);
  up = false;
  await minutes(t, w, 3, 6);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
  up = true;
  await minutes(t, w, 6, 7);
  assert.equal(notAnswering(w)[0].status, "resolved");
});

test("P7: a customer's report attaches a journey check to its case, never a health check, and none when the project has only probes", async (t) => {
  const w = world(t);
  network(t, () => null);
  const { appId } = await shop(w);
  // Registration writes health first, so it is the project's first row.
  await probe(w, appId, "health");
  const book = await journey(w, appId, "Book an appointment", "/journey-check");
  await w.db.insert("intakeKeys", { appId, key: "tik_shop", createdAt: 1 });
  const land = async (reportId) => {
    await w.run("internal.intake.records.receive", { key: "tik_shop", text: `Booking fails (${reportId}).`, reporterId: `device-${reportId}`, reportId });
    const triageId = w.rows("reportTriage").find((one) => one.status === "pending")._id;
    return await w.run("internal.intake.records.land", { triageId, verdict: "bug", source: "rules", reason: ".", open: { title: `Booking fails ${reportId}`, impact: "." } });
  };
  const first = await land("one");
  assert.equal(w.rows("cases").find((one) => one._id === first.caseId).journeyId, book);
  await w.db.patch(book, { retiredAt: at(0) });
  // What is left: the health check, and a prevention check, which runs the journey with a fault put in on purpose.
  await w.db.insert("journeys", { appId, name: "Booking survives a slow store", description: ".", checkVersion: "journey-check-v1+slow_store", check: journeyCheck("/journey-check?scenario=slow_store"), preventionFindingId: "structuralFindings:1" });
  const second = await land("two");
  assert.equal(w.rows("cases").find((one) => one._id === second.caseId).journeyId, undefined, "with no journey check left, the case has none: not the health check, and not a prevention check");
});

// =====================================================================================================================
// Part 2: retiring a check
// =====================================================================================================================

const MERGE = "1111111111111111111111111111111111111111";
const HEAD_2 = "2222222222222222222222222222222222222222";
const HEAD_3 = "3333333333333333333333333333333333333333";
const manifestOf = (journeys, extra = {}) => JSON.stringify({ version: 1, journeys: journeys.map((name) => ({ name, path: `/checks/${name.toLowerCase().replace(/\W+/g, "-")}/journey-check` })), ...extra });

/**
 * A project prepared through onboarding, its repository on a stand-in for GitHub (`repo.head` is the branch's latest
 * commit, `repo.files` turtl.json at each commit), and its app on a stand-in that answers every route unless told not to.
 */
async function prepared(t, w, files) {
  // `head`: the latest commit on main, the branch the preparation merged into. `mainGone`: that branch no longer
  // exists (renamed or deleted). `defaultBranch` and `others`: the repository's default branch, and other branches' heads.
  // `branchError`: GitHub answers the read of main with a server error, though the rest of it works. `goneStatus`: what
  // GitHub answers for a branch that is not there (404, or 422 "No commit found").
  const repo = { head: MERGE, files: { ...files }, githubDown: false, mainGone: false, defaultBranch: "main", others: {}, branchError: false, goneStatus: 404 };
  const app = { answer: (target) => (target.pathname.endsWith("/journey-check") ? json(passed) : healthy()) };
  const sent = network(t, (host) => {
    if (host === "api.github.com") return (target) => {
      if (repo.githubDown) return json({ message: "Server Error" }, 500);
      if (target.pathname === "/repos/o/shop") return json({ default_branch: repo.defaultBranch });
      const branch = target.pathname.match(/^\/repos\/o\/shop\/commits\/(.+)$/)?.[1];
      const name = branch === undefined ? undefined : decodeURIComponent(branch);
      if (name === "main" && repo.branchError) return json({ message: "Server Error" }, 502);
      const sha = name === "main" ? (repo.mainGone ? undefined : repo.head) : repo.others[name];
      return sha ? json({ sha }) : json({ message: repo.goneStatus === 422 ? "No commit found for SHA: " + name : "Not Found" }, repo.goneStatus);
    };
    if (host === "raw.githubusercontent.com") return (target) => {
      const [, , , sha, ...path] = target.pathname.split("/");
      const text = path.join("/") === "turtl.json" ? repo.files[sha] : undefined;
      return text === undefined ? new Response("404: Not Found", { status: 404 }) : new Response(text, { status: 200 });
    };
    return host === HOST ? (target, init) => app.answer(target, init) : null;
  });
  const { owner, appId } = await shop(w);
  const preparationId = await w.db.insert("onboardingPreparations", { appId, neverBreak: [], repo: "o/shop", baseBranch: "main", approvedAt: 1, mergedAt: 2, settledAt: 2, mergeCommitSha: MERGE, nextSyncAt: Number.MAX_SAFE_INTEGER });
  /** The registration that follows the merge: turtl.json at the merge commit. */
  const afterMerge = () => w.run("internal.onboarding.prepare.register", { preparationId });
  /** The owner's Check again, to its end. */
  const checkAgain = async () => {
    const registration = (await w.db.get(preparationId)).registration;
    if (registration?.requestedAt !== undefined) await w.db.patch(preparationId, { registration: { ...registration, requestedAt: registration.requestedAt - 3 * MINUTE } });
    await w.run("api.onboarding.projects.checkAgain", { projectId: appId }, owner);
    return await w.drain(["internal.onboarding.prepare.register"]);
  };
  const checks = () => w.rows("journeys").filter((one) => one.appId === appId);
  const live = () => checks().filter((one) => one.retiredAt === undefined).map((one) => one.name);
  const named = (name) => checks().find((one) => one.name === name);
  const registration = async () => (await w.db.get(preparationId)).registration;
  return { repo, app, sent, owner, appId, preparationId, afterMerge, checkAgain, checks, live, named, registration };
}

test("registration writes a health and a readiness check as GETs that say which probe they are", async (t) => {
  const shape = (one) => ({ method: one.check.config.method, probe: one.probe, version: one.checkVersion, passed: one.lastPassedAt !== undefined });
  const version = `onboarding-manifest-v1:${MERGE.slice(0, 12)}`;
  await t.test("each endpoint that answers", async (t) => {
    const w = world(t);
    const p = await prepared(t, w, { [MERGE]: manifestOf(["Book"], { health: { name: "Server answers", path: "/health" }, readiness: { name: "Ready to take bookings", path: "/ready" } }) });
    assert.deepEqual((await p.afterMerge()).outcome, "registered");
    assert.deepEqual(shape(p.named("Server answers")), { method: "GET", probe: "health", version, passed: true });
    assert.deepEqual(shape(p.named("Ready to take bookings")), { method: "GET", probe: "readiness", version, passed: true });
    assert.deepEqual(shape(p.named("Book")), { method: "POST", probe: undefined, version, passed: true });
    assert.deepEqual(p.sent.filter((request) => request.host === HOST).map((request) => [request.path, request.method]), [["/health", "GET"], ["/ready", "GET"], ["/checks/book/journey-check", "POST"]]);
  });
  await t.test("a readiness check that says not ready is registered, and has not passed", async (t) => {
    const w = world(t);
    const q = await prepared(t, w, { [MERGE]: manifestOf([], { readiness: { name: "Ready", path: "/ready" } }) });
    q.app.answer = notReady;
    await q.afterMerge();
    assert.deepEqual([shape(q.named("Ready")), (await q.registration()).checks.map((check) => [check.kind, check.state, check.detail])], [{ method: "GET", probe: "readiness", version, passed: false }, [["readiness", "failing", "Answered that the app is not ready to serve customers now."]]]);
  });
});

test("T8: Check again reads turtl.json as it is now on the preparation's branch; the registration after the merge reads the merge commit", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book", "Refund"]) });
  await p.afterMerge();
  assert.deepEqual(p.live(), ["Book", "Cancel"]);
  assert.deepEqual(p.sent.filter((request) => request.host === "api.github.com"), [], "the merge commit is known: GitHub is not asked for the branch's head");
  assert.equal((await p.registration()).ref, MERGE);

  p.repo.head = HEAD_2;
  const [job] = await p.checkAgain();
  assert.deepEqual([job.args.preparationId, job.args.latest, typeof job.args.startedAt], [p.preparationId, true, "number"], "the latest file, and which request this is");
  assert.ok(p.sent.some((request) => request.host === "raw.githubusercontent.com" && request.path === `/o/shop/${HEAD_2}/turtl.json`));
  assert.deepEqual([p.live(), (await p.registration()).ref, (await p.registration()).status], [["Book", "Refund"], HEAD_2, "done"]);
});

test("T2, T3: a check turtl.json no longer lists is retired when registration runs again: not sent, not shown, its counts gone, and the owner is told", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"], { health: { name: "Server answers", path: "/health" } }), [HEAD_2]: manifestOf(["Book"], { health: { name: "Server answers", path: "/health" } }) });
  await p.afterMerge();
  await minutes(t, w, 0, 2);
  const cancel = p.named("Cancel")._id;
  await w.db.patch(cancel, { unanswered: { count: 2, since: at(0), at: at(1), latest: { kind: "no_response", timedOut: false } }, passingSince: at(0) });
  const before = p.sent.filter((request) => request.path === "/checks/cancel/journey-check").length;
  assert.ok(before >= 2, "the monitor was sending it");

  p.repo.head = HEAD_2;
  await p.checkAgain();
  const retired = row(w, cancel);
  assert.deepEqual([typeof retired.retiredAt, retired.unanswered, retired.passingSince, retired.name], ["number", undefined, undefined, "Cancel"], "kept, marked, and its counts cleared");
  assert.deepEqual(p.live(), ["Server answers", "Book"], "the others are untouched");
  assert.equal((await p.registration()).note, 'turtl stopped checking "Cancel": turtl.json no longer lists it.');
  assert.deepEqual((await p.registration()).checks.map((check) => check.name), ["Server answers", "Book"]);

  await minutes(t, w, 2, 12);
  assert.equal(p.sent.filter((request) => request.path === "/checks/cancel/journey-check").length, before, "and not one more request reaches it");
});

test("T2: nothing is sent to a retired check, by the monitor or by a later Check again", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  await p.afterMerge();
  await minutes(t, w, 0, 2);
  p.repo.head = HEAD_2;
  await p.checkAgain();
  const mark = p.sent.length;
  await minutes(t, w, 2, 30);
  await p.checkAgain();
  await minutes(t, w, 30, 40);
  assert.deepEqual(p.sent.slice(mark).filter((request) => request.path === "/checks/cancel/journey-check"), []);
  assert.deepEqual((await overview(w, p.appId, p.owner)).map((check) => check.name), ["Book"]);
});

test("T1: rows that do not come from turtl.json are never retired", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book"]), [HEAD_2]: JSON.stringify({ version: 1, journeys: [], flags: [{ name: "Recommendations", field: "recommendationsEnabled", path: "/flags" }] }) });
  p.app.answer = (target) => (target.pathname === "/flags" ? json({ recommendationsEnabled: true }) : json(passed));
  await p.afterMerge();
  const caseId = await w.db.insert("cases", { appId: p.appId, title: ".", impact: ".", kind: "outage", raisedBy: "monitor", status: "resolved" });
  const findingId = await w.db.insert("structuralFindings", { appId: p.appId, caseId, stepAttemptId: "stepAttempts:1", agentRunId: "agentRuns:1", hypothesis: ".", evidence: [], change: { title: ".", kind: "code", description: "." }, test: { description: ".", disprovedIf: "." }, confidence: 0.5, connectedCaseIds: [caseId], seededCaseCount: 0 });
  const others = {
    "a prevention check": await w.db.insert("journeys", { appId: p.appId, name: "Booking survives a slow store", description: ".", checkVersion: "journey-check-v1+slow_store", check: journeyCheck("/checks/book/journey-check?scenario=slow_store"), preventionFindingId: findingId }),
    "the demo's booking journey": await w.db.insert("journeys", { appId: p.appId, name: "Book an appointment", description: ".", checkVersion: "journey-check-v1", check: journeyCheck("/journey-check") }),
    "a dev fixture": await w.db.insert("journeys", { appId: p.appId, name: "Proof", description: ".", checkVersion: "proof-v1", check: journeyCheck("/proof/journey-check") }),
    // A prevention check that happens to carry a manifest-looking version is still a prevention check.
    "a prevention check with a manifest version": await w.db.insert("journeys", { appId: p.appId, name: "Guard", description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck("/guard/journey-check"), preventionFindingId: findingId }),
  };
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.equal(typeof p.named("Book").retiredAt, "number", "the manifest's own row is retired");
  for (const [what, id] of Object.entries(others)) assert.equal(row(w, id).retiredAt, undefined, what);
});

test("T1: a practice project's check and the demo's registry are out of registration's reach", async (t) => {
  const records = createLoader()("convex/onboarding/records.ts");
  const practice = { checkVersion: "journey-check-v1" };
  assert.equal(records.fromManifest(practice), false);
  assert.equal(records.fromManifest({ checkVersion: "onboarding-manifest-v1:abc" }), true);
  assert.equal(records.fromManifest({ checkVersion: "onboarding-manifest-v1:abc", preventionFindingId: "structuralFindings:1" }), false);
  assert.equal(records.fromManifest({ checkVersion: "onboarding-manifest-v1" }), false, "the prefix with its colon, nothing shorter");
  void t;
});

test("T2: a registration that fails retires nothing, and a check that does not answer just now stays listed", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: "{ not json", [HEAD_3]: manifestOf(["Book", "Cancel"]) });
  await p.afterMerge();
  // The file is broken at the head.
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.deepEqual([(await p.registration()).status, p.live()], ["failed", ["Book", "Cancel"]]);
  // The file is gone at the head.
  p.repo.head = "4444444444444444444444444444444444444444";
  await p.checkAgain();
  assert.deepEqual([(await p.registration()).status, p.live()], ["failed", ["Book", "Cancel"]]);
  // Listed, but its route does not answer now: it stays registered, and says so.
  p.repo.head = HEAD_3;
  p.app.answer = (target) => (target.pathname.includes("/cancel/") ? down() : json(passed));
  await p.checkAgain();
  assert.deepEqual([(await p.registration()).status, p.live()], ["done", ["Book", "Cancel"]]);
  assert.match((await p.registration()).checks.find((check) => check.name === "Cancel").detail, /It stays registered from an earlier check\.$/);
});

test("T8: when GitHub cannot say what the branch's head is, Check again changes nothing and never falls back to an older commit", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  await p.afterMerge();
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.deepEqual(p.live(), ["Book"]);
  p.repo.githubDown = true;
  const mark = p.sent.length;
  await p.checkAgain();
  const registration = await p.registration();
  assert.equal(registration.status, "failed");
  assert.equal(registration.error, "turtl could not read the latest commit on main in o/shop, so it checked nothing and changed nothing. Try again in a few minutes.");
  assert.deepEqual(p.live(), ["Book"], "Cancel did not come back from the merge commit's list");
  assert.deepEqual(p.sent.slice(mark).filter((request) => request.host === "raw.githubusercontent.com" || request.host === HOST), [], "no file was read and the app was not called");
});

test("T6: listing a check again revives the same row with its history; a renamed check is a new row", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]), [HEAD_3]: manifestOf(["Book", "Cancel", "Refund"]) });
  await p.afterMerge();
  const cancel = p.named("Cancel");
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.equal(typeof p.named("Cancel").retiredAt, "number");
  p.repo.head = HEAD_3;
  t.mock.timers.setTime(at(10));
  await p.checkAgain();
  const revived = p.named("Cancel");
  assert.deepEqual([revived._id, revived.retiredAt, p.checks().filter((one) => one.name === "Cancel").length], [cancel._id, undefined, 1]);
  assert.equal((await p.registration()).note, undefined);
  assert.deepEqual(p.live(), ["Book", "Cancel", "Refund"]);
  assert.notEqual(p.named("Refund")._id, cancel._id);
});

test("T8: a check keeps its version while its address is unchanged, so Check again after an unrelated commit changes none", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book"]), [HEAD_2]: manifestOf(["Book"]), [HEAD_3]: JSON.stringify({ version: 1, journeys: [{ name: "Book", path: "/v2/journey-check" }] }) });
  await p.afterMerge();
  const version = p.named("Book").checkVersion;
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.equal(p.named("Book").checkVersion, version);
  p.repo.head = HEAD_3;
  await p.checkAgain();
  assert.deepEqual([p.named("Book").checkVersion, p.named("Book").check.config.url], [`onboarding-manifest-v1:${HEAD_3.slice(0, 12)}`, `https://${HOST}/v2/journey-check`], "a new address is a new version");
});

test("T7: at most 25 retired rows are kept for a project; the oldest go", async (t) => {
  const w = world(t);
  const names = (from, to) => Array.from({ length: to - from }, (_, n) => `Check ${String(from + n).padStart(2, "0")}`);
  const p = await prepared(t, w, { [MERGE]: manifestOf(names(0, 20)), [HEAD_2]: manifestOf(names(20, 40)), [HEAD_3]: manifestOf(["Only"]) });
  await p.afterMerge();
  p.repo.head = HEAD_2;
  t.mock.timers.setTime(at(1));
  await p.checkAgain();
  p.repo.head = HEAD_3;
  t.mock.timers.setTime(at(5));
  await p.checkAgain();
  const retired = p.checks().filter((one) => one.retiredAt !== undefined).map((one) => one.name).sort();
  assert.equal(retired.length, 25);
  assert.deepEqual(retired, names(15, 40), "the 15 retired first are gone");
  assert.deepEqual(p.live(), ["Only"]);
});

test("T4: an open case about a retired check carries on, the monitor opens no new one for it, and its verify pass closes no not-answering case", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  p.app.answer = (target) => (target.pathname.includes("/cancel/") ? json(failed, 503) : json(passed));
  await p.afterMerge();
  await w.db.patch(p.named("Cancel")._id, { lastPassedAt: START - HOUR });
  await minutes(t, w, 0, 2);
  const [open] = ordinary(w);
  assert.equal(open.journeyId, p.named("Cancel")._id);
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.deepEqual(ordinary(w).map((one) => one.status), ["investigating"], "nothing was closed for it");
  assert.equal((await w.db.get(open.journeyId)).name, "Cancel", "and the case still finds its check");
  // A round that was in flight when the check was retired reports its failure afterwards: no case opens. Everything
  // else that could refuse is out of the way: the earlier case is closed, and the check has passed since it (the
  // fixture stamps rows in 2027, so "since" is later still).
  await w.db.patch(open._id, { status: "resolved" });
  const since = w.rows("cases").find((one) => one._id === open._id)._creationTime + HOUR;
  await w.db.patch(open.journeyId, { lastPassedAt: since });
  const failure = { journeyId: open.journeyId, failedStep: "save_booking", observedAt: since + MINUTE, counts: null, countsReason: "." };
  const late = await w.run("internal.monitor.openCase", failure);
  assert.deepEqual([late.opened, late.reason, ordinary(w).length], [false, "this check was retired: the project's turtl.json no longer lists it", 1]);
  // The same failure of the same check, were it not retired, would open a case: the refusal is the retirement's.
  const retiredAt = row(w, open.journeyId).retiredAt;
  await w.db.patch(open.journeyId, { retiredAt: undefined });
  assert.equal((await w.run("internal.monitor.openCase", failure)).opened, true);
  await w.db.patch(open.journeyId, { retiredAt });
  await w.db.patch(ordinary(w).at(-1)._id, { status: "resolved" });
  // A not-answering case is open on the project; the retired check's verify step passes.
  const book = p.named("Book")._id;
  p.app.answer = down;
  await minutes(t, w, 2, 6);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
  await w.run("internal.monitor.recordPass", { journeyId: open.journeyId, observedAt: Date.now() + 5 });
  assert.equal(notAnswering(w)[0].status, "waiting_for_app", "a retired check is no evidence");
  assert.ok(count(w, book) >= 3);
});

test("T5: a retired check cannot stop a not-answering case from opening: it is not sent, and a late result from it is dropped", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  // Cancel's route goes on passing for ever; Book's stops answering after the retirement.
  let bookDown = false;
  p.app.answer = (target) => (target.pathname.includes("/book/") && bookDown ? down() : json(passed));
  await p.afterMerge();
  await minutes(t, w, 0, 2);
  p.repo.head = HEAD_2;
  await p.checkAgain();
  bookDown = true;
  await untilCase(t, w, 2);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app", "Cancel still passes on the app, but turtl no longer asks it");
  assert.equal(opened.impact, 'At least three tries in a row of the "Book" check got no usable answer: turtl could not connect to the app.');
});

test("T5: a result handed to the end of a round for a retired check, from a round in flight when it was retired, is dropped", async (t) => {
  const w2 = world(t);
  network(t, () => null);
  const { appId } = await shop(w2);
  const book = await w2.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck("/book/journey-check"), lastPassedAt: START - HOUR, unanswered: { count: 2, since: at(0), at: at(1), latest: { kind: "no_response", timedOut: false } } });
  const gone = await w2.db.insert("journeys", { appId, name: "Cancel", description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck("/cancel/journey-check"), lastPassedAt: START - HOUR, retiredAt: at(1) });
  const settled = await w2.run("internal.protectedApp.notAnswering.settle", { appId, tries: [{ journeyId: book, at: at(2), got: { kind: "no_response", timedOut: false } }, { journeyId: gone, at: at(2), got: { kind: "passed" } }] });
  assert.equal(settled.kind, "would_open", "the retired check's pass did not stop it");
  assert.deepEqual(settled.ran, [book]);
});

test("T5: a retired check cannot leave a not-answering case open: the round after decides from what is left", async (t) => {
  for (const [what, left, expected] of [
    ["nothing is left to run", [], /^turtl stopped checking this project, so it closed this case without knowing whether the app answers again\./],
    ["what is left gives replies turtl cannot read", ["Renamed"], new RegExp(`^${CANNOT_TELL.replace(/[.?]/g, "\\$&")}$`)],
  ]) {
    await t.test(what, async (t) => {
      const w = world(t);
      const p = await prepared(t, w, { [MERGE]: manifestOf(["Book"]), [HEAD_2]: left.length ? manifestOf(left) : JSON.stringify({ version: 1, journeys: [], flags: [{ name: "Recommendations", field: "recommendationsEnabled", path: "/flags" }] }) });
      let state = "up";
      p.app.answer = (target) => {
        if (target.pathname === "/flags") return json({ recommendationsEnabled: true });
        if (state === "up") return json(passed);
        // Down: the old route gives nothing. The renamed route exists at registration, then answers 404.
        if (target.pathname.includes("/book/")) return down();
        return state === "registering" ? json(passed) : new Response("Not Found", { status: 404 });
      };
      await p.afterMerge();
      await minutes(t, w, 0, 2);
      state = "down";
      await minutes(t, w, 2, 6);
      const [opened] = notAnswering(w);
      assert.equal(opened?.status, "waiting_for_app");
      // The owner takes the quiet check out of turtl.json and taps Check again.
      p.repo.head = HEAD_2;
      state = "registering";
      await p.checkAgain();
      state = "down";
      assert.equal(typeof p.named("Book").retiredAt, "number");
      await minutes(t, w, 6, 9);
      assert.deepEqual(notAnswering(w).map((one) => one.status), ["unresolved"], "within a few minutes, not left open");
      assert.match(closing(w, opened._id).summary, expected);
      assert.equal(w.rows("apps").find((one) => one._id === p.appId).notAnsweringCase, undefined);
      assert.deepEqual(pushes(w), ["not_answering"], "and no 'answering again'");
      await minutes(t, w, 9, 60);
      assert.equal(notAnswering(w).length, 1, "nor does the retired check ever open another");
    });
  }
});

test("T5: with a case open, retiring one quiet check leaves the case to the checks that are still quiet, and it closes when they answer", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  let state = "up";
  p.app.answer = () => (state === "down" ? down() : json(passed));
  await p.afterMerge();
  await minutes(t, w, 0, 2);
  state = "down";
  await minutes(t, w, 2, 6);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
  // Check again while the app is down: Book does not answer, so it "stays registered from an earlier check".
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.deepEqual(p.live(), ["Book"]);
  await minutes(t, w, 6, 20);
  assert.deepEqual(notAnswering(w).map((one) => one.status), ["waiting_for_app"], "Book is still quiet: the case stays open");
  state = "up";
  await minutes(t, w, 20, 40);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w)], [["resolved"], ["not_answering", "answering_again"]]);
});

test("T3, R9: the single-owner demo's monitor leaves a retired check alone too", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: `https://${HOST}`, PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  const sent = network(t, (host) => (host === HOST ? () => json(passed) : null));
  const appId = await w.db.insert("apps", { name: "Demo shop", productionUrl: `https://${HOST}` });
  await journey(w, appId, "Book", "/book/journey-check");
  await w.db.insert("journeys", { appId, name: "Cancel", description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck("/cancel/journey-check"), lastPassedAt: START - HOUR, retiredAt: at(-1) });
  await minutes(t, w, 0, 5);
  assert.deepEqual([...new Set(sent.filter((request) => request.host === HOST).map((request) => request.path))], ["/book/journey-check"]);
});

test("deleting a project still removes its retired checks", async (t) => {
  const w = world(t);
  network(t, () => null);
  const { appId } = await shop(w);
  await journey(w, appId, "Book", "/book/journey-check");
  await w.db.insert("journeys", { appId, name: "Cancel", description: ".", checkVersion: MANIFEST_VERSION, check: journeyCheck("/cancel/journey-check"), retiredAt: at(-1) });
  const { projectErasers } = w.load("convex/account/registry.ts");
  const { eraseRows } = w.load("convex/account/erasers.ts");
  const entry = projectErasers.find((one) => one.table === "journeys");
  assert.equal(entry.index, "by_app", "the index that holds every row of the project, retired or not");
  await eraseRows({ db: w.db }, entry, appId, 100);
  assert.deepEqual(w.rows("journeys"), []);
});

// =====================================================================================================================
// After the independent review (.claude/security/watched-checks-review.md, N1 to N9).
// =====================================================================================================================

/**
 * Rounds that outlive their five-minute lease while the app is down behind a proxy: each round is still running when
 * the next starts, and settles only after the next one has sent its checks. The journey check's connection hangs until
 * the round's time runs out; the proxy answers /health by itself.
 */
async function overlapping(t, { withHealth }) {
  const w = world(t);
  const hanging = [];
  network(t, (host) => (host === HOST
    ? (target) => (target.pathname === "/health" ? healthy() : new Promise((_, reject) => hanging.push(() => reject(new TypeError("fetch failed")))))
    : null));
  const { appId } = await shop(w);
  const book = await journey(w, appId, "Book an appointment", "/journey-check");
  if (withHealth) await probe(w, appId, "health");
  t.mock.timers.setTime(at(0));
  let { running: previous } = await startRound(w);
  // Sixteen minutes apart: past the longest wait between checks of a project that keeps failing the same way.
  for (let round = 1; round <= 10; round++) {
    t.mock.timers.setTime(at(round * 16));
    const { running: next } = await startRound(w);
    hanging.shift()();
    await previous;
    await w.drain(RUNS);
    previous = next;
  }
  return { w, book };
}

test("N1: in a journey project, a health check's pass in a newer round does not make an older round decide nothing: overlapping rounds still open the case, as they do without a health check", async (t) => {
  const opened = {};
  for (const withHealth of [false, true]) {
    await t.test(withHealth ? "with a health check that passes" : "without a health check", async (t) => {
      const { w, book } = await overlapping(t, { withHealth });
      assert.ok(count(w, book) >= 3, `the journey check's quiet tries are counted (${count(w, book)})`);
      assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
      assert.deepEqual(pushes(w), ["not_answering"]);
      opened[withHealth] = notAnswering(w)[0]._creationTime;
    });
  }
});

test("N1, K1: where the probes decide, a probe's pass in a newer round still makes an older round decide nothing", async (t) => {
  const w = world(t);
  let mode = "down";
  let release;
  network(t, (host) => (host === HOST ? () => (mode === "down" ? down() : mode === "up" ? healthy() : new Promise((resolve) => { release = () => resolve(healthy()); })) : null));
  const { appId } = await shop(w);
  const health = await probe(w, appId, "health");
  await minutes(t, w, 0, 8);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
  // Minute 20: round A starts while the app briefly answers, and its health check hangs before A settles.
  mode = "slow";
  t.mock.timers.setTime(at(20));
  const { running: roundA } = await startRound(w);
  // Down again. Minute 26: A's lease has run out, round B runs and finds the app down.
  mode = "down";
  t.mock.timers.setTime(at(26));
  await w.run("internal.monitor.tick", {});
  await w.drain(RUNS);
  const afterB = row(w, health).unanswered;
  release();
  await roundA;
  await w.drain(RUNS);
  assert.deepEqual([notAnswering(w).map((one) => one.status), pushes(w)], [["waiting_for_app"], ["not_answering"]], "round A is older than round B: its pass closes nothing");
  assert.deepEqual(row(w, health).unanswered, afterB, "and changes no count");
});

test("N2: a slow Check again that finishes after a newer one writes nothing: the newer list stands, and so does the commit it read", async (t) => {
  for (const ending of ["registers", "fails"]) {
    await t.test(`the older one ${ending}`, async (t) => {
      const w = world(t);
      const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book", "Cancel"]), [HEAD_3]: manifestOf(["Book"]) });
      await p.afterMerge();
      assert.deepEqual(p.live(), ["Book", "Cancel"]);
      // Check again #1 reads the head at HEAD_2, which still lists Cancel. The app is slow: one call hangs.
      let release;
      p.app.answer = (target) => (target.pathname.includes("/cancel/") ? new Promise((resolve) => { release = () => resolve(json(passed)); }) : json(passed));
      p.repo.head = HEAD_2;
      if (ending === "fails") p.repo.files[HEAD_2] = "{ not json";
      t.mock.timers.setTime(at(0));
      await w.run("api.onboarding.projects.checkAgain", { projectId: p.appId }, p.owner);
      const [first] = w.scheduled.splice(w.scheduled.findIndex((job) => job.path === "internal.onboarding.prepare.register"), 1);
      // The older one's read of turtl.json is held too when it is to fail, so that it ends after the newer one.
      let releaseRead;
      const realFetch = globalThis.fetch;
      if (ending === "fails") {
        globalThis.fetch = async (url, init) => (String(url).includes(`/${HEAD_2}/turtl.json`) ? new Promise((resolve) => { releaseRead = () => resolve(realFetch(url, init)); }) : realFetch(url, init));
      }
      const slow = w.run(first.path, first.args);
      await flush();
      // The owner takes Cancel out (HEAD_3) and, three minutes later, taps Check again (#2), which finishes at once.
      p.app.answer = (target) => (target.pathname.includes("/cancel/") ? down() : json(passed));
      p.repo.head = HEAD_3;
      t.mock.timers.setTime(at(3));
      await w.run("api.onboarding.projects.checkAgain", { projectId: p.appId }, p.owner);
      await w.drain(["internal.onboarding.prepare.register"]);
      assert.deepEqual([p.live(), (await p.registration()).ref, (await p.registration()).status], [["Book"], HEAD_3, "done"]);
      // #1 finishes now.
      (releaseRead ?? release)();
      await slow;
      globalThis.fetch = realFetch;
      const registration = await p.registration();
      assert.deepEqual([p.live(), registration.ref, registration.status, registration.error], [["Book"], HEAD_3, "done", undefined], "the older registration changed nothing");
      assert.equal(registration.note, 'turtl stopped checking "Cancel": turtl.json no longer lists it.');
      const mark = p.sent.length;
      await minutes(t, w, 4, 8);
      assert.deepEqual(p.sent.slice(mark).filter((request) => request.path === "/checks/cancel/journey-check"), [], "and the monitor does not send Cancel");
    });
  }
});

test("N2: the registration after the merge and a Check again are told apart the same way; an operator's run from the command line always writes", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  // The merge starts the first registration (as applySnapshot does), and the owner taps Check again before it ends.
  await w.db.patch(p.preparationId, { registration: { status: "checking", checks: [], ref: MERGE, startedAt: at(0) } });
  p.repo.head = HEAD_2;
  t.mock.timers.setTime(at(1));
  await p.checkAgain();
  assert.deepEqual([p.live(), (await p.registration()).ref], [["Book"], HEAD_2]);
  // The merge's registration ends late: it writes nothing.
  await w.run("internal.onboarding.prepare.register", { preparationId: p.preparationId, startedAt: at(0) });
  assert.deepEqual([p.live(), (await p.registration()).ref], [["Book"], HEAD_2]);
  // An operator checking a commit by hand names no start: it always writes.
  await w.run("internal.onboarding.prepare.register", { preparationId: p.preparationId, ref: MERGE });
  assert.deepEqual([p.live(), (await p.registration()).ref], [["Book", "Cancel"], MERGE]);
});

test("N4: a check that turns from a probe into a journey check under the same name starts with no history", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: JSON.stringify({ version: 1, health: { name: "Bookings", path: "/health" }, journeys: [] }), [HEAD_2]: JSON.stringify({ version: 1, journeys: [{ name: "Bookings", path: "/checks/bookings/journey-check" }] }) });
  await p.afterMerge();
  await minutes(t, w, 0, 3);
  const before = p.named("Bookings");
  assert.deepEqual([before.probe, typeof before.lastPassedAt, typeof before.passingSince], ["health", "number", "number"]);
  // The journey check answers at registration, with a failing result: it is registered, and has never passed.
  p.app.answer = (target) => (target.pathname.endsWith("/journey-check") ? json(failed, 503) : healthy());
  p.repo.head = HEAD_2;
  await p.checkAgain();
  const after = p.named("Bookings");
  assert.deepEqual([after._id, after.check.config.method, after.probe], [before._id, "POST", undefined], "the same row, now a journey check");
  assert.deepEqual([after.lastPassedAt, after.passingSince, after.unanswered], [undefined, undefined, undefined], "the health check's passes are not a journey check's");
  // So its first failure is not recorded as the end of days of passing.
  await minutes(t, w, 3, 5);
  assert.deepEqual(ordinary(w).map((one) => one.passingForMs), [0]);
});

test("N4: a pass recorded for a retired check starts no run of passes, and reviving it starts afresh", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]), [HEAD_3]: manifestOf(["Book", "Cancel"]) });
  await p.afterMerge();
  await minutes(t, w, 0, 2);
  p.repo.head = HEAD_2;
  await p.checkAgain();
  const cancel = p.named("Cancel")._id;
  assert.equal(row(w, cancel).passingSince, undefined);
  // A case that still runs it records a pass, two days before it is listed again.
  await w.run("internal.monitor.recordPass", { journeyId: cancel, observedAt: at(5) });
  assert.deepEqual([row(w, cancel).lastPassedAt, row(w, cancel).passingSince], [at(5), undefined]);
  await w.db.patch(cancel, { passingSince: at(5) });
  p.repo.head = HEAD_3;
  t.mock.timers.setTime(at(2 * 24 * 60));
  await p.checkAgain();
  assert.deepEqual([row(w, cancel).retiredAt, row(w, cancel).passingSince], [undefined, undefined], "its run of passes starts when the monitor next sees it pass");
});

test("N5, T1: a turtl.json entry named like a check registration does not own leaves that check as it is, and gets a row of its own", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: JSON.stringify({ version: 1, health: { name: "Guard", path: "/health" }, journeys: [{ name: "Book an appointment", path: "/checks/book/journey-check" }] }), [HEAD_2]: manifestOf(["Other"]) });
  const prevention = await w.db.insert("journeys", { appId: p.appId, name: "Guard", description: "A prevention check.", checkVersion: "journey-check-v1+slow_store", check: journeyCheck("/guard/journey-check?scenario=slow_store"), preventionFindingId: "structuralFindings:1", lastPassedAt: START - HOUR });
  const demo = await w.db.insert("journeys", { appId: p.appId, name: "Book an appointment", description: "The demo's own.", checkVersion: "journey-check-v1", check: journeyCheck("/journey-check") });
  const untouched = [row(w, prevention), row(w, demo)];
  await p.afterMerge();
  assert.deepEqual([row(w, prevention), row(w, demo)], untouched, "neither was written over");
  const mine = p.checks().filter((one) => one.checkVersion.startsWith("onboarding-manifest-v1:"));
  assert.deepEqual(mine.map((one) => [one.name, one.check.config.method, one.probe]), [["Guard", "GET", "health"], ["Book an appointment", "POST", undefined]]);
  // Taken out of the file again: the manifest's own two rows are retired, the other two still run.
  p.repo.head = HEAD_2;
  await p.checkAgain();
  assert.deepEqual([row(w, prevention), row(w, demo)], untouched);
  assert.deepEqual(p.live(), ["Guard", "Book an appointment", "Other"]);
  assert.deepEqual(mine.map((one) => typeof row(w, one._id).retiredAt), ["number", "number"]);
});

test("N5: the demo's registry does not hand back a retired check as its booking journey", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: `https://${HOST}`, PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  network(t, () => null);
  const first = await w.run("internal.protectedApp.registry.register", {});
  await w.db.patch(first.journeyId, { retiredAt: at(-1) });
  const again = await w.run("internal.protectedApp.registry.register", {});
  assert.notEqual(again.journeyId, first.journeyId);
  assert.deepEqual([again.created.journey, row(w, again.journeyId).retiredAt], [true, undefined]);
});

test("N7, T8: when the preparation's branch is gone, Check again reads the repository's default branch; when that cannot be read either, it changes nothing", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  await p.afterMerge();
  // main was renamed to trunk, which is now the default branch.
  p.repo.mainGone = true;
  p.repo.defaultBranch = "trunk";
  p.repo.others.trunk = HEAD_2;
  await p.checkAgain();
  assert.deepEqual([(await p.registration()).status, (await p.registration()).ref, p.live()], ["done", HEAD_2, ["Book"]]);
  // S2: the owner is told which branch was read, beside what was retired.
  assert.equal((await p.registration()).note, 'turtl read turtl.json on trunk, the default branch of o/shop, because the branch main is no longer there. turtl stopped checking "Cancel": turtl.json no longer lists it.');
  // No branch can be read at all: nothing is checked and nothing changes.
  p.repo.others = {};
  const mark = p.sent.length;
  await p.checkAgain();
  const registration = await p.registration();
  assert.deepEqual([registration.status, p.live()], ["failed", ["Book"]]);
  assert.equal(registration.error, "turtl could not find the branch main in o/shop, or the repository's default branch, so it checked nothing and changed nothing. Check that the repository is still connected to turtl.");
  assert.deepEqual(p.sent.slice(mark).filter((request) => request.host === HOST), []);
});

test("T8: a check's version changes when the way it is sent changes, its credential included, and stands when nothing does", async (t) => {
  const w = world(t);
  network(t, () => null);
  const { appId } = await shop(w);
  const preparationId = await w.db.insert("onboardingPreparations", { appId, neverBreak: [], repo: "o/shop", mergedAt: 2, settledAt: 2 });
  const register = (version, config) => w.run("internal.onboarding.records.register", {
    id: preparationId, ref: version,
    checks: [{ result: { kind: "journey", name: "Book", url: config.url, state: "works", detail: ".", checkedAt: Date.now() }, journey: { name: "Book", description: ".", check: { kind: "http", config }, checkVersion: `onboarding-manifest-v1:${version}` }, passedAt: Date.now() }],
  });
  const config = { url: `https://${HOST}/journey-check`, method: "POST", expectedStatus: 200 };
  const version = () => w.rows("journeys")[0].checkVersion;
  await register("aaa", config);
  await register("bbb", config);
  assert.equal(version(), "onboarding-manifest-v1:aaa", "the same check keeps its version");
  await register("ccc", { ...config, credentialRef: "PROTECTED_APP_CONTROL_SECRET" });
  assert.equal(version(), "onboarding-manifest-v1:ccc", "now sent with the control token: a new version");
  await register("ddd", { ...config, credentialRef: "PROTECTED_APP_CONTROL_SECRET" });
  assert.equal(version(), "onboarding-manifest-v1:ccc");
  await register("eee", config);
  assert.equal(version(), "onboarding-manifest-v1:eee");
  assert.equal(w.rows("journeys").length, 1);
});

test("P6, N9: a journey project whose journey checks wait for a control token is paced by the checks it can send", async (t) => {
  const { CREDENTIAL_REF } = createLoader()("convex/protectedApp/client.ts");
  const gated = (path) => ({ kind: "http", config: { url: `https://${HOST}${path}`, method: "POST", expectedStatus: 200, credentialRef: CREDENTIAL_REF } });
  await t.test("only probes can be sent, and they keep failing the same way: spaced out", async (t) => {
    const w = world(t);
    const sent = network(t, (host) => (host === HOST ? down : null));
    const { appId } = await shop(w);
    await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: MANIFEST_VERSION, check: gated("/journey-check"), lastPassedAt: START - HOUR });
    await probe(w, appId, "health");
    await minutes(t, w, 0, 60);
    const rounds = sent.filter((request) => request.path === "/health").length;
    assert.ok(rounds <= 12, `checked ${rounds} times in an hour`);
    assert.ok(w.rows("watchedProjects")[0].failure.streak >= 5);
    assert.deepEqual(notAnswering(w), [], "and no case opens on the health check: the journey check decides, token or no token");
  });
  await t.test("only probes can be sent, and they pass: every minute", async (t) => {
    const w = world(t);
    const sent = network(t, (host) => (host === HOST ? healthy : null));
    const { appId } = await shop(w);
    await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: MANIFEST_VERSION, check: gated("/journey-check"), lastPassedAt: START - HOUR });
    await probe(w, appId, "health");
    await minutes(t, w, 0, 30);
    assert.equal(sent.filter((request) => request.path === "/health").length, 30);
  });
  await t.test("the line is drawn from the project's checks, not from what a round could send", async (t) => {
    const w = world(t);
    // Book has passed and waits for its token. Pay has never passed and needs none: it gets no answer. Health passes.
    const sent = network(t, (host) => (host === HOST ? (target) => (target.pathname === "/health" ? healthy() : down()) : null));
    const { appId } = await shop(w);
    await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: MANIFEST_VERSION, check: gated("/book/journey-check"), lastPassedAt: START - HOUR });
    await journey(w, appId, "Pay", "/pay/journey-check", { passed: false });
    await probe(w, appId, "health");
    await minutes(t, w, 0, 60);
    const rounds = sent.filter((request) => request.path === "/pay/journey-check").length;
    assert.ok(rounds <= 12, `the passing health check did not put it back to every minute (${rounds} rounds in an hour)`);
  });
});

// ---- After the second review pass (S1 to S6, and the four mutations it left standing).

test("N7: only a branch that is gone sends Check again to the default branch: a 422 counts as gone, and GitHub not answering does not", async (t) => {
  await t.test("GitHub answers 422 for the missing branch", async (t) => {
    const w = world(t);
    const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
    await p.afterMerge();
    Object.assign(p.repo, { mainGone: true, goneStatus: 422, defaultBranch: "trunk", others: { trunk: HEAD_2 } });
    await p.checkAgain();
    assert.deepEqual([(await p.registration()).status, (await p.registration()).ref, p.live()], ["done", HEAD_2, ["Book"]]);
  });
  await t.test("GitHub does not answer for the branch, though another branch could be read", async (t) => {
    const w = world(t);
    const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
    await p.afterMerge();
    // main is still there; GitHub just fails to read it. trunk, the default branch, lists fewer checks.
    Object.assign(p.repo, { branchError: true, defaultBranch: "trunk", others: { trunk: HEAD_2 } });
    await p.checkAgain();
    const registration = await p.registration();
    assert.deepEqual([registration.status, p.live()], ["failed", ["Book", "Cancel"]], "nothing was read from the other branch, and nothing retired");
    assert.equal(registration.error, "turtl could not read the latest commit on main in o/shop, so it checked nothing and changed nothing. Try again in a few minutes.");
    assert.ok(!p.sent.some((request) => request.path === "/repos/o/shop/commits/trunk"));
  });
});

test("N2: the registration the merge starts names its start too, so a Check again made before it ends is the one that stands", async (t) => {
  const w = world(t);
  const p = await prepared(t, w, { [MERGE]: manifestOf(["Book", "Cancel"]), [HEAD_2]: manifestOf(["Book"]) });
  // The preparation's pull request is seen merged: this starts the registration.
  await w.db.patch(p.preparationId, { mergedAt: undefined, settledAt: undefined, number: 7 });
  t.mock.timers.setTime(at(0));
  const snapshot = { title: "Prepare", url: "https://github.com/o/shop/pull/7", headSha: MERGE, state: "merged", checks: "passing", checkRuns: [], mergeable: false, mergeableState: "merged" };
  await w.run("internal.onboarding.records.applySnapshot", { id: p.preparationId, snapshot, mergeCommitSha: MERGE });
  const [afterMerge] = w.scheduled.splice(w.scheduled.findIndex((job) => job.path === "internal.onboarding.prepare.register"), 1);
  assert.deepEqual([afterMerge.args.startedAt, (await p.registration()).startedAt, (await p.registration()).status], [at(0), at(0), "checking"]);
  // The owner takes Cancel out and taps Check again before the merge's registration has ended.
  p.repo.head = HEAD_2;
  t.mock.timers.setTime(at(1));
  await p.checkAgain();
  assert.deepEqual([p.live(), (await p.registration()).ref, (await p.registration()).startedAt], [["Book"], HEAD_2, at(1)]);
  // The merge's registration ends now, with the merge commit's list: it writes nothing.
  await w.run(afterMerge.path, afterMerge.args);
  assert.deepEqual([p.live(), (await p.registration()).ref], [["Book"], HEAD_2]);
});

test("N2: only the request the project is waiting for writes: a run that names any other start, earlier or later, writes nothing", async (t) => {
  const w = world(t);
  network(t, () => null);
  const { appId } = await shop(w);
  const preparationId = await w.db.insert("onboardingPreparations", { appId, neverBreak: [], repo: "o/shop", mergedAt: 2, settledAt: 2, registration: { status: "checking", checks: [], startedAt: at(5) } });
  const config = { url: `https://${HOST}/journey-check`, method: "POST", expectedStatus: 200 };
  const checks = [{ result: { kind: "journey", name: "Book", url: config.url, state: "works", detail: ".", checkedAt: at(5) }, journey: { name: "Book", description: ".", check: { kind: "http", config }, checkVersion: "onboarding-manifest-v1:aaa" }, passedAt: at(5) }];
  const status = async () => [(await w.db.get(preparationId)).registration.status, w.rows("journeys").length];
  for (const startedAt of [at(4), at(9)]) {
    await w.run("internal.onboarding.records.register", { id: preparationId, ref: "aaa", checks, startedAt });
    await w.run("internal.onboarding.records.failRegistration", { id: preparationId, error: "It failed.", startedAt });
    assert.deepEqual(await status(), ["checking", 0], `a run started at minute ${(startedAt - START) / MINUTE}`);
  }
  await w.run("internal.onboarding.records.register", { id: preparationId, ref: "aaa", checks, startedAt: at(5) });
  assert.deepEqual([...(await status()), (await w.db.get(preparationId)).registration.startedAt], ["done", 1, at(5)]);
});
