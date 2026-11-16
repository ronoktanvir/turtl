import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createBackend, createLoader, root } from "./fixtures/convex-backend.mjs";

// Cases for an app that stops answering. turtl checks an owner's live app about once a minute; when the app gives no
// usable reply three tries in a row, turtl opens one case for the project, tells the owner, shows the checks as not
// answering, and closes the case with a second notice when the app answers again. Each test runs the real monitor
// (convex/monitor.ts, convex/protectedApp/) on an in-memory copy of every table, minute by minute, against stand-ins
// for the owners' apps and turtl's own site.

const KEY = randomBytes(32).toString("base64");
const ACCOUNTS = { AUTH_REQUIRED: "true", SECRETS_ENCRYPTION_KEY: KEY };
const VARIABLES = [
  "AUTH_REQUIRED", "SECRETS_ENCRYPTION_KEY", "PROTECTED_APP_URL", "PROTECTED_APP_CONTROL_SECRET", "CONVEX_SITE_URL", "CONVEX_CLOUD_URL",
  "WATCHED_APP_ALLOW_LOOPBACK", "KEIKI_API_KEY", "KEIKI_AGENT_ID", "KEIKI_OWNER_CONTACT", "OPENAI_API_KEY", "GITHUB_TOKEN", "CAPY_API_KEY",
];
const START = Date.parse("2026-11-16T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (minute) => START + minute * MINUTE;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const passed = { runId: "run-1", verdict: "passed", failedStep: null, error: null, steps: [], cleanup: { ok: true, deletedBookings: 0 }, revision: "abc1234", environment: "test", startedAt: 1, completedAt: 2 };
const failed = { ...passed, verdict: "failed", failedStep: "save_booking", error: { code: "STORE_DOWN", message: "The store is down." } };
/** The app is down: the connection fails. */
const down = () => {
  throw new TypeError("fetch failed");
};
/** A host's error page: a reply, but no check result. */
const errorPage = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });

/** A stand-in for every outside address: `route(host)` answers, and every request is recorded. */
function network(t, route) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    sent.push({ host: target.host, path: target.pathname, at: Date.now() });
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
  // Every job ever scheduled, so a test can say what was never started (drain drops jobs it does not run).
  const seen = new Set();
  const push = backend.scheduled.push.bind(backend.scheduled);
  backend.scheduled.push = (...jobs) => {
    for (const job of jobs) seen.add(job);
    return push(...jobs);
  };
  return { load, seen, ...backend };
}

/** A project on its own https origin with `checks` checks that need no control token. */
async function project(w, owner, host, checks = 1) {
  const appId = await w.db.insert("apps", { name: `Shop ${host}`, ownerId: owner, repoUrl: `https://github.com/o/${host}`, productionUrl: `https://${host}` });
  for (let n = 0; n < checks; n++) {
    await w.db.insert("journeys", { appId, name: `Check ${n}`, description: ".", checkVersion: "v1", check: { kind: "http", config: { url: `https://${host}/check-${n}/journey-check`, method: "POST", expectedStatus: 200 } } });
  }
  return appId;
}

const RUNS = ["internal.monitor.checkProject", "internal.notices.notifyOwner", "internal.protectedApp.notAnswering.stopped"];

/** Runs the monitor's cron once a minute from `from` to `to`, every scheduled check and notice to completion. */
async function minutes(t, w, from, to) {
  for (let minute = from; minute < to; minute++) {
    t.mock.timers.setTime(at(minute));
    await w.run("internal.monitor.tick", {});
    await w.drain(RUNS);
  }
}

const notAnswering = (w) => w.rows("cases").filter((row) => row.signature?.startsWith("not_answering:"));
const ordinary = (w) => w.rows("cases").filter((row) => row.signature?.startsWith("journey_failed:"));
const events = (w) => w.rows("ownerNotices").map((row) => row.event);
const jobs = (w, path) => [...w.seen].filter((job) => job.path === path);
const pushes = (w) => jobs(w, "internal.push.deliver.forNotice").map((job) => job.args.event);
const counts = (w, appId) => w.rows("journeys").filter((row) => row.appId === appId).map((row) => row.unanswered?.count ?? 0);
const overview = async (w, appId, owner) => (await w.run("api.screens.overview.forProject", { projectId: appId }, owner)).checks;

// ---- R1: what counts as unanswered ----

test("R1: a check with no result says whether turtl did not send it, got no response, or got a reply with no result", async (t) => {
  const client = createLoader()("convex/protectedApp/client.ts");
  const app = { refuse: () => null, token: async () => ({ ok: true, token: "t" }), followRedirects: false };
  let answer = () => assert.fail("nothing is sent");
  t.mock.method(globalThis, "fetch", async (_url, init) => answer(init));
  const check = { url: "https://shop.example/journey-check" };

  const refused = await client.runJourneyCheck(check, { ...app, refuse: () => "turtl sends this project's requests only to its own address, so it sent nothing" });
  assert.deepEqual([refused.ok, refused.kind], [false, "not_sent"], "an address turtl may not send to");
  const noToken = await client.runJourneyCheck({ ...check, credentialRef: client.CREDENTIAL_REF }, { ...app, token: async () => ({ ok: false, reason: "no control token is set" }) });
  assert.deepEqual([noToken.ok, noToken.kind, noToken.reason], [false, "not_sent", "no control token is set"], "a missing token");

  answer = down;
  const refusedConnection = await client.runJourneyCheck(check, app);
  assert.deepEqual(refusedConnection, { ok: false, kind: "no_response", timedOut: false, reason: "the request failed (TypeError)" });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  answer = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const pending = client.runJourneyCheck(check, app);
  t.mock.timers.tick(30_000);
  assert.deepEqual(await pending, { ok: false, kind: "no_response", timedOut: true, reason: "no response within 30 s" });

  answer = errorPage;
  assert.deepEqual(await client.runJourneyCheck(check, app), { ok: false, kind: "no_result", status: 502, reason: "the booking check returned HTTP 502 with no verdict" });
  answer = () => json({ ok: true });
  assert.deepEqual(await client.runJourneyCheck(check, app), { ok: false, kind: "no_result", status: 200, reason: "the booking check returned HTTP 200 with no verdict" });
  answer = () => json(failed, 503);
  assert.equal((await client.runJourneyCheck(check, app)).ok, true, "a failing check is a usable reply");
});

// ---- R2: counting, per check ----

test("R2: each try that gets no usable answer counts on its check; a pass or a failure clears the count, and one blip shows nothing", async (t) => {
  const w = world(t);
  let answer = () => json(passed);
  network(t, (host) => (host === "shop.example" ? () => answer() : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 1);

  answer = down;
  await minutes(t, w, 1, 2);
  let [journey] = w.rows("journeys");
  assert.deepEqual(journey.unanswered, { count: 1, since: at(1), at: at(1), latest: { kind: "no_response", timedOut: false } });
  // One blip: nothing the owner can see.
  assert.deepEqual([notAnswering(w), events(w), pushes(w)], [[], [], []]);
  const [shown] = await overview(w, appId, ada);
  assert.equal(shown.state, "passing");
  assert.equal(shown.notAnswering, undefined);

  answer = errorPage;
  await minutes(t, w, 2, 3);
  [journey] = w.rows("journeys");
  assert.deepEqual(journey.unanswered, { count: 2, since: at(1), at: at(2), latest: { kind: "no_result", status: 502 } });

  // A failing check is a usable reply: the count is cleared, and the ordinary case opens as it always has.
  answer = () => json(failed);
  await minutes(t, w, 3, 4);
  assert.equal(w.rows("journeys")[0].unanswered, undefined);
  assert.equal(ordinary(w).length, 1);
  assert.deepEqual(notAnswering(w), []);

  // So is a pass.
  answer = down;
  await minutes(t, w, 4, 5);
  assert.equal(w.rows("journeys")[0].unanswered.count, 1);
  answer = () => json(passed);
  await minutes(t, w, 5, 6);
  assert.equal(w.rows("journeys")[0].unanswered, undefined);
});

test("R2: a pass a case's verify step records clears the count too", async (t) => {
  const w = world(t);
  network(t, () => null);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  const [journey] = w.rows("journeys").filter((row) => row.appId === appId);
  await w.db.patch(journey._id, { unanswered: { count: 2, since: at(-2), at: at(-1), latest: { kind: "no_response", timedOut: true } } });
  await w.run("internal.monitor.recordPass", { journeyId: journey._id, observedAt: at(0) });
  assert.equal(w.rows("journeys")[0].unanswered, undefined);
});

test("R1: a check turtl did not send never counts", async (t) => {
  const w = world(t);
  const sent = network(t, () => () => json(passed));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  // A row aimed at another origin than the project's live address is never sent (convex/protectedApp/address.ts).
  const [journey] = w.rows("journeys");
  await w.db.patch(journey._id, { check: { kind: "http", config: { url: "https://elsewhere.example/journey-check", method: "POST", expectedStatus: 200 } } });
  await minutes(t, w, 0, 20);
  assert.deepEqual(sent.filter((request) => request.host === "elsewhere.example"), [], "nothing was sent");
  assert.deepEqual(counts(w, appId), [0]);
  assert.deepEqual([notAnswering(w), events(w)], [[], []]);
});

// ---- R3 and R5: opening, once per project ----

test("R3, R5: the third try in a row with no answer opens one case for the project, however many checks it has, parked and never run", async (t) => {
  const w = world(t);
  let answer = () => json(passed);
  network(t, (host) => (host === "shop.example" ? () => answer() : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 3);
  await minutes(t, w, 0, 1);

  answer = down;
  // Checked at 1 and 2 (every minute), then spaced out: the third try is at minute 4 (convex/protectedApp/watching.ts).
  await minutes(t, w, 1, 4);
  assert.deepEqual(counts(w, appId), [2, 2, 2]);
  assert.deepEqual([notAnswering(w), events(w), pushes(w)], [[], [], []], "two tries in a row do nothing visible");
  assert.ok((await overview(w, appId, ada)).every((check) => check.state === "passing" && check.notAnswering === undefined));

  await minutes(t, w, 4, 5);
  assert.deepEqual(counts(w, appId), [3, 3, 3]);
  const [opened, ...more] = notAnswering(w);
  assert.deepEqual(more, [], "one case for three checks");
  assert.deepEqual(
    { kind: opened.kind, raisedBy: opened.raisedBy, journeyId: opened.journeyId, signature: opened.signature, status: opened.status, passingForMs: opened.passingForMs },
    { kind: "outage", raisedBy: "monitor", journeyId: undefined, signature: `not_answering:${appId}`, status: "waiting_for_app", passingForMs: undefined },
  );
  assert.match(opened.title, /not answering/);
  assert.match(opened.impact, /turtl's last 3 tries of 3 checks \("Check 0", "Check 1" and "Check 2"\) got no usable answer: turtl could not connect to the app\./);
  assert.match(opened.impact, /cannot propose a fix for an app it cannot reach/);
  for (const raw of ["TypeError", "fetch failed", "not_answering", "no_response"]) assert.ok(!opened.impact.includes(raw), raw);
  // One step, parked from the start, and nothing ever scheduled to run it.
  const steps = w.rows("steps").filter((step) => step.caseId === opened._id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "waiting");
  const attempts = w.rows("stepAttempts").filter((attempt) => attempt.caseId === opened._id);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["waiting"]);
  assert.deepEqual([...w.seen].filter((job) => job.path.startsWith("internal.runner.")), [], "no step was dispatched, no time limit set");
  // The owner is told once, on their phone too, with the project's name in the words for the demo's text message.
  assert.deepEqual(events(w), ["not_answering"]);
  assert.deepEqual(pushes(w), ["not_answering"]);
  assert.match(jobs(w, "internal.notices.notifyOwner")[0].args.text, /^Shop shop\.example is not answering turtl's checks\./);
  // The project shows its checks as not answering.
  const shown = await overview(w, appId, ada);
  assert.ok(shown.every((check) => check.state === "failing" && check.notAnswering?.tries === 3 && check.notAnswering.since === at(1)), JSON.stringify(shown));

  // More tries with no answer open nothing more and tell the owner nothing more.
  await minutes(t, w, 5, 40);
  assert.equal(notAnswering(w).length, 1);
  assert.ok(counts(w, appId).every((count) => count > 4));
  assert.deepEqual([events(w), pushes(w)], [["not_answering"], ["not_answering"]]);
});

test("R3: a reply with no check result counts like no reply, and only the checks that ran decide", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? errorPage : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  const [opened] = notAnswering(w);
  assert.ok(opened, "opened after three error pages in a row");
  assert.match(opened.impact, /the app replied with HTTP 502 but no check result/);
  assert.deepEqual(counts(w, appId), [3, 3]);
});

test("R3: two rounds deciding at once open one case: the decision re-reads the state in its own transaction", async (t) => {
  const w = world(t);
  network(t, () => null);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  const ids = w.rows("journeys").map((row) => row._id);
  for (const id of ids) await w.db.patch(id, { unanswered: { count: 3, since: at(-3), at: at(0), latest: { kind: "no_response", timedOut: false } } });
  for (let n = 0; n < 2; n++) await w.run("internal.protectedApp.notAnswering.open", { appId, ran: ids, turtl: "reachable" });
  assert.equal(notAnswering(w).length, 1);
});

// ---- R4 and R5: closing ----

test("R4, R5: when the app answers again the case closes with what turtl saw, and the owner is told a second time", async (t) => {
  const w = world(t);
  let answer = down;
  network(t, (host) => (host === "shop.example" ? () => answer() : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  const [opened] = notAnswering(w);
  assert.equal(opened.status, "waiting_for_app");

  answer = () => json(passed);
  // Tried again at minute 7 (the back-off is left as it is).
  await minutes(t, w, 4, 8);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolvedAt, at(7));
  const [step] = w.rows("steps").filter((row) => row.caseId === closed._id);
  assert.equal(step.status, "done");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.equal(attempt.status, "done");
  assert.equal(attempt.summary, "The app answered turtl's checks again after about 7 minutes without an answer. Its checks pass now.");
  assert.deepEqual(events(w), ["not_answering", "answering_again"]);
  assert.deepEqual(pushes(w), ["not_answering", "answering_again"]);
  assert.match(jobs(w, "internal.notices.notifyOwner")[1].args.text, /^Shop shop\.example is answering turtl's checks again\.$/);
  assert.deepEqual(counts(w, appId), [0, 0]);
  assert.ok((await overview(w, appId, ada)).every((check) => check.state === "passing" && check.notAnswering === undefined));

  // Down again: another case, and another pair of notices.
  answer = down;
  await minutes(t, w, 8, 12);
  assert.deepEqual(notAnswering(w).map((row) => row.status), ["resolved", "waiting_for_app"]);
  assert.deepEqual(events(w), ["not_answering", "answering_again", "not_answering"]);
});

test("R4: when the app answers with a failing check, the case closes and the ordinary case opens as it always has", async (t) => {
  const w = world(t);
  let answer = down;
  network(t, (host) => (host === "shop.example" ? (target) => answer(target) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  assert.equal(notAnswering(w).length, 1);

  answer = (target) => (target.pathname.startsWith("/check-1/") ? json(failed, 503) : json(passed));
  await minutes(t, w, 4, 8);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "resolved");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.equal(attempt.summary, "The app answered turtl's checks again after about 7 minutes without an answer. \"Check 1\" fails now, which turtl handles as a separate issue.");
  const [failing] = ordinary(w);
  assert.equal(failing.signature, `journey_failed:${w.rows("journeys")[1]._id}`);
  // The failure's own notice was sent during the round, before the round closed the case.
  assert.deepEqual(events(w), ["not_answering", "opened", "answering_again"]);
  const shown = await overview(w, appId, ada);
  assert.deepEqual(shown.map((check) => [check.state, check.notAnswering]), [["passing", undefined], ["failing", undefined]]);
});

test("R4: a case stays open while any check that ran is still not answering", async (t) => {
  const w = world(t);
  let answer = down;
  network(t, (host) => (host === "shop.example" ? (target) => answer(target) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  answer = (target) => (target.pathname.startsWith("/check-1/") ? down() : json(passed));
  await minutes(t, w, 4, 10);
  assert.deepEqual(notAnswering(w).map((row) => row.status), ["waiting_for_app"]);
  assert.deepEqual(events(w), ["not_answering"]);
});

// ---- R6: turtl checks itself first ----

test("R6: while turtl's own requests do not get out, no case opens and the counts are held; the next round asks again and opens it", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: "https://turtl-site.example" });
  let turtlOnline = false;
  const sent = network(t, (host) => (host === "shop.example" ? down : host === "turtl-site.example" ? () => (turtlOnline ? new Response("No matching routes found", { status: 404 }) : down()) : null));
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  const toTurtl = () => sent.filter((request) => request.host === "turtl-site.example").length;

  await minutes(t, w, 0, 2);
  assert.equal(toTurtl(), 0, "no request to turtl's own site while no case would open");
  await minutes(t, w, 2, 4);
  assert.equal(toTurtl(), 1, "one request, when a case would have opened");
  assert.deepEqual([notAnswering(w), events(w)], [[], []]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /turtl's own site/);
  assert.deepEqual(counts(w, appId), [2, 2], "held below the threshold");
  assert.ok((await overview(w, appId, ada)).every((check) => check.notAnswering === undefined), "the owner is not shown turtl's own problem");

  turtlOnline = true;
  await minutes(t, w, 4, 8);
  assert.equal(notAnswering(w).length, 1, "the next round opened it");
  assert.equal(toTurtl(), 2);
  await minutes(t, w, 8, 40);
  assert.equal(toTurtl(), 2, "no request once the case is open");
});

// ---- R3: the daily limit ----

test("R3: at most ten such cases a day for one project", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  const { NOT_ANSWERING_CASES_PER_DAY, UNANSWERED_AFTER } = w.load("convex/protectedApp/notAnswering.ts");
  assert.deepEqual([UNANSWERED_AFTER, NOT_ANSWERING_CASES_PER_DAY], [3, 10]);
  // Ten earlier today, the oldest 23 hours ago.
  for (let n = 0; n < 10; n++) {
    const id = await w.db.insert("cases", { appId, title: "x", impact: ".", kind: "outage", raisedBy: "monitor", status: "resolved", signature: `not_answering:${appId}` });
    await w.db.patch(id, { _creationTime: START - 23 * HOUR + n * HOUR });
  }
  await minutes(t, w, 0, 50);
  assert.equal(notAnswering(w).length, 10, "no eleventh within the day");
  assert.deepEqual(events(w), []);
  // An hour later the oldest is a day old, and the next round opens one.
  await minutes(t, w, 50, 80);
  assert.equal(notAnswering(w).filter((row) => row.status === "waiting_for_app").length, 1);
});

// ---- R4: turtl stops checking ----

test("R4: when turtl stops checking the project, the case closes with why, no second notice, and the counts are cleared", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  assert.equal(notAnswering(w).length, 1);
  // The owner takes the live address away.
  await w.db.patch(appId, { productionUrl: undefined });
  await minutes(t, w, 4, 20);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.equal(attempt.status, "done");
  assert.equal(attempt.summary, "turtl stopped checking this project, so it closed this case without knowing whether the app answers again. It has no live address, so turtl has nothing to check.");
  assert.deepEqual([events(w), pushes(w)], [["not_answering"], ["not_answering"]], "no \"answering again\"");
  assert.deepEqual(counts(w, appId), [0, 0]);
  assert.ok((await overview(w, appId, ada)).every((check) => check.notAnswering === undefined));
});

test("R4: a check that is no longer run, waiting for a control token, stops saying it is not answering", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? () => json(passed) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  const [, waiting] = w.rows("journeys");
  // Its last tries got no answer; now it needs a control token the project does not have, so it is not run.
  await w.db.patch(waiting._id, {
    check: { kind: "http", config: { url: "https://shop.example/check-1/journey-check", method: "POST", expectedStatus: 200, credentialRef: "PROTECTED_APP_CONTROL_SECRET" } },
    unanswered: { count: 4, since: at(-10), at: at(-1), latest: { kind: "no_response", timedOut: true } },
  });
  assert.equal((await overview(w, appId, ada))[1].notAnswering?.tries, 4);
  await minutes(t, w, 0, 1);
  assert.deepEqual(counts(w, appId), [0, 0]);
  assert.equal((await overview(w, appId, ada))[1].notAnswering, undefined);
});

test("R4: with every check not sent, an open case closes as turtl having stopped checking", async (t) => {
  const w = world(t);
  let aimed = "shop.example";
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  assert.equal(notAnswering(w).length, 1);
  aimed = "elsewhere.example";
  const [journey] = w.rows("journeys");
  await w.db.patch(journey._id, { check: { kind: "http", config: { url: `https://${aimed}/journey-check`, method: "POST", expectedStatus: 200 } } });
  await minutes(t, w, 4, 10);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.match(attempt.summary, /^turtl stopped checking this project, so it closed this case without knowing whether the app answers again\. turtl could not send its checks to the app\.$/);
  assert.deepEqual(events(w), ["not_answering"]);
  assert.deepEqual(counts(w, appId), [0]);
});

// ---- Constraints: no new reads on a healthy turn ----

test("a healthy project's turn reads no case and decides nothing new", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? () => json(passed) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  await project(w, ada, "shop.example", 25);
  await minutes(t, w, 0, 10);
  assert.deepEqual(w.reads.filter(([table]) => table === "cases"), []);
  assert.deepEqual([...w.seen].filter((job) => job.path.includes("notAnswering")), []);
  assert.ok(w.reads.filter(([table]) => table === "journeys").every(([, , documents]) => documents <= 25));
});

test("only the monitor's own rounds count: no case step records a try", () => {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name === "_generated" ? [] : files(join(dir, entry.name))) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
  const callers = files(join(root, "convex")).filter((file) => /\bsettleRound\(|notAnswering\.(settle|open)\b/.test(readFileSync(file, "utf8"))).map((file) => relative(root, file));
  assert.deepEqual(callers.sort(), ["convex/monitor.ts", "convex/protectedApp/notAnswering.ts"]);
});

// ---- R9: the single-owner demo ----

test("R9: the single-owner demo follows the same rules", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: "https://booking.example", PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  let answer = () => json(passed);
  network(t, (host) => (host === "booking.example" ? () => answer() : null));
  const appId = await w.db.insert("apps", { name: "Booking demo", productionUrl: "https://booking.example" });
  for (let n = 0; n < 2; n++) {
    await w.db.insert("journeys", { appId, name: `Book ${n}`, description: ".", checkVersion: "v1", check: { kind: "http", config: { url: `https://booking.example/journey-check?n=${n}`, method: "POST", expectedStatus: 200 } } });
  }
  await minutes(t, w, 0, 1);
  answer = down;
  await minutes(t, w, 1, 3);
  assert.deepEqual(notAnswering(w), [], "two minutes of no answer");
  await minutes(t, w, 3, 4);
  const [opened, ...more] = notAnswering(w);
  assert.deepEqual(more, []);
  assert.equal(opened.status, "waiting_for_app");
  assert.deepEqual(events(w), ["not_answering"]);
  assert.match(jobs(w, "internal.notices.notifyOwner")[0].args.text, /^Booking demo is not answering turtl's checks\./);
  await minutes(t, w, 4, 10);
  assert.equal(notAnswering(w).length, 1);
  answer = () => json(passed);
  await minutes(t, w, 10, 11);
  assert.equal(notAnswering(w)[0].status, "resolved");
  assert.deepEqual(events(w), ["not_answering", "answering_again"]);
  assert.deepEqual(counts(w, appId), [0, 0]);

  // Down again, then the demo's app loses its address: the case closes as turtl having stopped checking.
  answer = down;
  await minutes(t, w, 11, 14);
  assert.equal(notAnswering(w).at(-1).status, "waiting_for_app");
  await w.db.patch(appId, { productionUrl: undefined });
  await minutes(t, w, 14, 15);
  assert.equal(notAnswering(w).at(-1).status, "unresolved");
  assert.deepEqual(counts(w, appId), [0, 0]);
  assert.deepEqual(events(w), ["not_answering", "answering_again", "not_answering"]);
});

test("R9: a deployment that holds accounts but runs as the demo still checks nothing and opens nothing", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: "https://booking.example", PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  const sent = network(t, () => down);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  await project(w, ada, "booking.example");
  await minutes(t, w, 0, 10);
  assert.deepEqual([sent, w.rows("cases"), counts(w, w.rows("apps")[0]._id)], [[], [], [0]]);
});
