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

/** `clock`: cases are stamped with the test's clock, as Convex stamps them, so a 24-hour window can run out. */
function world(t, env = ACCOUNTS, { clock = false } = {}) {
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
  if (clock) {
    // The fixture stamps every row in 2027; a case the code makes is stamped now instead (a fraction apart, in order).
    const insert = backend.db.insert;
    let order = 0;
    backend.db.insert = async (table, fields) => {
      const id = await insert(table, fields);
      if (table === "cases") await backend.db.patch(id, { _creationTime: Date.now() + ++order / 1000 });
      return id;
    };
  }
  return { load, seen, ...backend };
}

/**
 * A project on its own https origin with `checks` checks that need no control token. `passed`: its checks passed an
 * hour before the test starts, as a project turtl has watched does (only a check that has passed can stop answering).
 */
async function project(w, owner, host, checks = 1, { passed = true } = {}) {
  const appId = await w.db.insert("apps", { name: `Shop ${host}`, ownerId: owner, repoUrl: `https://github.com/o/${host}`, productionUrl: `https://${host}` });
  for (let n = 0; n < checks; n++) {
    await w.db.insert("journeys", { appId, name: `Check ${n}`, description: ".", checkVersion: "v1", check: { kind: "http", config: { url: `https://${host}/check-${n}/journey-check`, method: "POST", expectedStatus: 200 } }, ...(passed && { lastPassedAt: START - HOUR }) });
  }
  return appId;
}

/**
 * A health and a readiness endpoint registered as journeys beside a project's real checks, exactly as onboarding's
 * register writes them (convex/onboarding/prepare.ts, checkLive): a GET check, passed at registration from its 200.
 * The monitor runs every journey with the booking journey contract, so these two never return a check result.
 */
async function healthAndReadiness(w, appId, host) {
  for (const [name, path] of [["Health", "/health"], ["Ready to serve", "/ready"]]) {
    await w.db.insert("journeys", { appId, name, description: ".", checkVersion: "journey-check-v1:abc123", check: { kind: "http", config: { url: `https://${host}${path}`, method: "GET", expectedStatus: 200 } }, lastPassedAt: START - HOUR });
  }
}
/** What a health or readiness endpoint answers turtl's journey check: 200, and no check result. */
const healthReply = () => json({ ok: true, service: "shop" });

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
  // True while the app is quiet and after the case closes.
  assert.equal(opened.title, "Your app stopped answering");
  // What turtl saw, and only that: the case page says the rest while the case is open, and shows this line again once
  // it is closed, when "it keeps checking" would no longer be true.
  // No exact number of tries: a check's count can be held below the threshold while turtl checks itself, so the case
  // says "at least three" rather than a count that may be wrong by the time it opens.
  assert.equal(opened.impact, "At least three tries in a row of each of 3 checks (\"Check 0\", \"Check 1\" and \"Check 2\") got no usable answer: turtl could not connect to the app.");
  assert.doesNotMatch(opened.impact, /last \d|\b\d+ tries/);
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
  // The case page reads whether every check that ran passed from the record, not from the sentence.
  assert.deepEqual({ answered: attempt.output.answered, allPassed: attempt.output.allPassed }, { answered: true, allPassed: true });
  assert.deepEqual(events(w), ["not_answering", "answering_again"]);
  assert.deepEqual(pushes(w), ["not_answering", "answering_again"]);
  // Not an all-clear: the app can come back with a failing check.
  assert.equal(jobs(w, "internal.notices.notifyOwner")[1].args.text, "Shop shop.example is answering turtl's checks again. Open the case in turtl to see whether they pass.");
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
  assert.deepEqual({ answered: attempt.output.answered, allPassed: attempt.output.allPassed }, { answered: true, allPassed: false });
  const [failing] = ordinary(w);
  assert.equal(failing.signature, `journey_failed:${w.rows("journeys")[1]._id}`);
  // The failure's own notice was sent during the round, before the round closed the case.
  assert.deepEqual(events(w), ["not_answering", "opened", "answering_again"]);
  const shown = await overview(w, appId, ada);
  assert.deepEqual(shown.map((check) => [check.state, check.notAnswering]), [["passing", undefined], ["failing", undefined]]);
});

test("V5: the case closes when any check answers, though another is still quiet; that one shows as not answering and opens no new case", async (t) => {
  const w = world(t);
  let answer = down;
  network(t, (host) => (host === "shop.example" ? (target) => answer(target) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  answer = (target) => (target.pathname.startsWith("/check-1/") ? down() : json(passed));
  await minutes(t, w, 4, 30);
  const [closed, ...more] = notAnswering(w);
  assert.deepEqual([closed.status, more], ["resolved", []], "the app answers, so it is not 'not answering'; no second case");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.deepEqual({ answered: attempt.output.answered, allPassed: attempt.output.allPassed }, { answered: true, allPassed: false });
  assert.match(attempt.summary, /"Check 1" got no answer this time\.$/);
  assert.deepEqual(events(w), ["not_answering", "answering_again"]);
  assert.ok(counts(w, appId)[1] >= 3);
  assert.deepEqual((await overview(w, appId, ada)).map((check) => [check.state, check.notAnswering !== undefined]), [["passing", false], ["failing", true]]);
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
  assert.deepEqual({ answered: attempt.output.answered, allPassed: attempt.output.allPassed }, { answered: false, allPassed: false }, "nothing ran, so nothing is said to pass");
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

// =====================================================================================================================
// Fixes after the independent review (.claude/security/not-answering-review.md, findings 1 to 4, 6 and 10).
// =====================================================================================================================

const SITE = "https://happy-otter-123.convex.site";
const SITE_HOST = new URL(SITE).host;
const OWN_SITE = { ...ACCOUNTS, CONVEX_SITE_URL: SITE, CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud" };
const turtlSite404 = () => new Response("No matching routes found", { status: 404 });

/** A practice project exactly as convex/practice/projects.ts makes one: turtl's own site, a managed sealed token. */
async function practiceProject(w, owner) {
  const rules = w.load("convex/practice/rules.ts");
  const { CREDENTIAL_REF, CHECK_VERSION } = w.load("convex/protectedApp/client.ts");
  const appId = await w.db.insert("apps", { name: "Practice booking app", ownerId: owner, practice: true });
  const base = rules.practiceBase(SITE, appId);
  await w.db.patch(appId, { productionUrl: base });
  await w.db.insert("practiceApps", { appId, ownerId: owner, tokenHash: "0".repeat(64), ...rules.WORKING, updatedAt: START });
  await w.db.insert("journeys", {
    appId, name: "Book an appointment", description: ".", checkVersion: CHECK_VERSION,
    check: { kind: "http", config: { url: `${base}/journey-check`, method: "POST", expectedStatus: 200, credentialRef: CREDENTIAL_REF } },
  });
  const seal = w.load("convex/secrets/seal.ts");
  const sealed = await seal.seal(`practice-token-${owner}`, `turtl-secret:control_token:${appId}`, await seal.sealingKey(KEY));
  await w.db.insert("secrets", { kind: "control_token", account: owner, appId, sealed: sealed.sealed, keyId: sealed.keyId, setAt: START });
  return appId;
}

const warningsOf = (t) => {
  const lines = [];
  t.mock.method(console, "warn", (...args) => lines.push(args.join(" ")));
  return lines;
};

// ---- Finding 1: a practice project's app is turtl's own code on turtl's own site ----

test("practice: turtl's own site failing never tells a practice owner their app is not answering; the operator's log hears of it once a round", async (t) => {
  const w = world(t, OWN_SITE);
  let turtlDown = false;
  const sent = network(t, (host) => (host === SITE_HOST
    ? (target) => (turtlDown ? new Response("Service Unavailable", { status: 503 }) : target.pathname.endsWith("/journey-check") ? json(passed) : turtlSite404())
    : null));
  const warnings = warningsOf(t);
  const owners = [];
  for (const name of ["ada", "bea", "cy", "dee"]) owners.push(await w.db.insert("users", { email: `${name}@example.com` }));
  const projects = [];
  for (const owner of owners) projects.push(await practiceProject(w, owner));
  await minutes(t, w, 0, 1);
  assert.ok(w.rows("journeys").every((row) => row.lastPassedAt === at(0)), "every practice app was checked and passed");

  turtlDown = true;
  const roundsBefore = jobs(w, "internal.monitor.checkProject").length;
  w.reads.length = 0;
  await minutes(t, w, 1, 30);
  assert.deepEqual(w.reads.filter(([table]) => table === "cases"), [], "a practice round settles nothing: no case is even read");
  assert.deepEqual(projects.map((appId) => counts(w, appId)), [[0], [0], [0], [0]], "no count on any practice check");
  assert.deepEqual([notAnswering(w), events(w), pushes(w)], [[], [], []], "no case and no notice");
  for (const [n, appId] of projects.entries()) {
    assert.ok((await overview(w, appId, owners[n])).every((check) => check.notAnswering === undefined));
  }
  const rounds = jobs(w, "internal.monitor.checkProject").length - roundsBefore;
  assert.ok(rounds >= 4 * 4, `practice rounds while turtl's site failed: ${rounds}`);
  assert.equal(warnings.length, rounds, "one warning a round");
  assert.ok(warnings.every((line) => /turtl's own practice app/.test(line)), warnings[0]);
  assert.deepEqual(sent.filter((request) => request.host === SITE_HOST && request.path === "/"), [], "no case would open, so turtl never asked its own site");
});

test("practice: its route failing (500) opens nothing, and Break and Put it back still work", async (t) => {
  const w = world(t, OWN_SITE);
  let practiceBroken = false;
  network(t, (host) => (host === SITE_HOST
    ? (target) => (target.pathname.startsWith("/practice/") ? (practiceBroken ? new Response(JSON.stringify({ code: "Server Error" }), { status: 500 }) : json(passed)) : turtlSite404())
    : null));
  warningsOf(t);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await practiceProject(w, ada);
  await minutes(t, w, 0, 1);
  practiceBroken = true;
  await minutes(t, w, 1, 20);
  assert.deepEqual([notAnswering(w), pushes(w), counts(w, appId)], [[], [], [0]]);
  assert.deepEqual((await overview(w, appId, ada)).map((check) => [check.state, check.notAnswering]), [["passing", undefined]]);
  assert.equal(typeof (await w.run("api.practice.projects.breakApp", { projectId: appId, failure: "recommendations" }, ada)).breaksLeft, "number");
  await w.run("api.practice.projects.mend", { projectId: appId }, ada);
});

test("practice: counts a practice check has on record go at its next round, and a case on it closes with why", async (t) => {
  const w = world(t, OWN_SITE);
  network(t, (host) => (host === SITE_HOST ? (target) => (target.pathname.startsWith("/practice/") ? new Response("", { status: 502 }) : turtlSite404()) : null));
  warningsOf(t);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await practiceProject(w, ada);
  const [journey] = w.rows("journeys");
  // A check that had passed and has a count on record, so only the practice rule keeps it from being "not answering".
  await w.db.patch(journey._id, { lastPassedAt: at(-30), unanswered: { count: 5, since: at(-10), at: at(-1), latest: { kind: "no_result", status: 502 } } });
  assert.equal((await overview(w, appId, ada))[0].notAnswering, undefined, "never shown as not answering, even with a count on record");
  assert.equal(await w.run("internal.protectedApp.notAnswering.open", { appId, ran: [journey._id], turtl: "reachable" }), null);
  assert.deepEqual(notAnswering(w), [], "open() refuses a practice project");
  const caseId = await w.db.insert("cases", { appId, title: "x", impact: ".", kind: "outage", raisedBy: "monitor", status: "waiting_for_app", signature: `not_answering:${appId}` });
  await minutes(t, w, 0, 2);
  assert.deepEqual(counts(w, appId), [0]);
  assert.equal(w.rows("cases").find((row) => row._id === caseId).status, "unresolved");
  assert.deepEqual(events(w), []);
});

// ---- Finding 1: turtl's own site answering with an error is not "getting out" ----

test("R6: turtl's own site answering 5xx or 429 is not 'getting out'; any other reply, a 404 included, is", async (t) => {
  const client = createLoader()("convex/protectedApp/client.ts");
  const saved = process.env.CONVEX_SITE_URL;
  t.after(() => (saved === undefined ? delete process.env.CONVEX_SITE_URL : (process.env.CONVEX_SITE_URL = saved)));
  let status = 404;
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => (asked.push(String(url)), status === null ? down() : new Response("x", { status })));
  delete process.env.CONVEX_SITE_URL;
  assert.equal(await client.turtlReachable(), true, "no site address set");
  assert.deepEqual(asked, []);
  process.env.CONVEX_SITE_URL = SITE;
  const answers = [];
  for (status of [500, 502, 503, 429, 404, 200, 301, 400, null]) answers.push([status, await client.turtlReachable()]);
  assert.deepEqual(answers, [[500, false], [502, false], [503, false], [429, false], [404, true], [200, true], [301, true], [400, true], [null, false]]);
  assert.ok(asked.every((url) => url === `${SITE}/`));
});

test("R6: an owner's app down while turtl's own site answers 503: no case, counts held; the site answering 404 lets it open", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  let siteStatus = 503;
  network(t, (host) => (host === "shop.example" ? down : host === SITE_HOST ? () => new Response("", { status: siteStatus }) : null));
  const warnings = warningsOf(t);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  assert.deepEqual([notAnswering(w), counts(w, appId)], [[], [2]]);
  assert.equal(warnings.length, 1);
  siteStatus = 404;
  await minutes(t, w, 4, 8);
  assert.equal(notAnswering(w).length, 1);
});

// ---- Finding 2: a fleet check before alerting, with accounts on ----

/** `n` projects, each on its own host shop<i>.example, each with its own owner. */
async function fleet(w, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const owner = await w.db.insert("users", { email: `owner${i}@example.com` });
    ids.push(await project(w, owner, `shop${i}.example`));
  }
  return ids;
}

test("fleet: six projects that all stop answering in the same minutes get no case, and turtl's own site is not asked", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  let fleetDown = false;
  const sent = network(t, (host) => (host === SITE_HOST ? turtlSite404 : host.endsWith(".example") ? () => (fleetDown ? down() : json(passed)) : null));
  const warnings = warningsOf(t);
  const ids = await fleet(w, 6);
  await minutes(t, w, 0, 1);
  fleetDown = true;
  await minutes(t, w, 1, 14);
  assert.deepEqual([notAnswering(w), events(w), pushes(w)], [[], [], []]);
  assert.ok(ids.every((appId) => counts(w, appId)[0] < 3), "held below the threshold, as when turtl's own site does not answer");
  assert.equal(sent.filter((request) => request.host === SITE_HOST).length, 0, "the fleet check comes first");
  assert.ok(warnings.length >= 6 && warnings.every((line) => /other projects/.test(line)), warnings[0]);
  // The fleet answers again: nothing was opened, and nothing opens.
  fleetDown = false;
  await minutes(t, w, 14, 30);
  assert.deepEqual([notAnswering(w), events(w)], [[], []]);
  assert.ok(ids.every((appId) => counts(w, appId)[0] === 0));
});

test("fleet: a hold lasts about half an hour; once the other projects' last answers are over 30 minutes old, each case opens", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  // The whole fleet goes quiet together at minute 1 (a shared host down, or turtl itself: from inside, the same).
  const sent = network(t, (host) => (host === SITE_HOST ? turtlSite404 : host.endsWith(".example") ? () => (Date.now() >= at(1) ? down() : json(passed)) : null));
  const warnings = warningsOf(t);
  const ids = await fleet(w, 6);
  // Checked at 1, 2, 4, 8, 16 and 31: held at 4, 8 and 16, while the others' last answers (minute 0) are recent.
  await minutes(t, w, 0, 30);
  assert.deepEqual([notAnswering(w), events(w)], [[], []], "held in its first half hour");
  assert.ok(warnings.length >= 6 && warnings.every((line) => /other projects/.test(line)));
  assert.equal(sent.filter((request) => request.host === SITE_HOST).length, 0);
  // At minute 31 those answers are 31 minutes old: no longer evidence, so turtl asks its own site, which answers.
  await minutes(t, w, 30, 40);
  assert.deepEqual(notAnswering(w).map((row) => row.appId).sort(), [...ids].sort());
  assert.ok(notAnswering(w).every((row) => row.status === "waiting_for_app"));
  assert.ok(sent.filter((request) => request.host === SITE_HOST).length >= 6, "turtl asked its own site before each opened");
});

test("fleet: with one other project still answering, each quiet project gets its case", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  network(t, (host) => (host === SITE_HOST ? turtlSite404 : host === "shop6.example" ? () => json(passed) : host.endsWith(".example") ? () => (Date.now() >= at(1) ? down() : json(passed)) : null));
  warningsOf(t);
  const ids = await fleet(w, 7);
  await minutes(t, w, 0, 6);
  assert.deepEqual(notAnswering(w).map((row) => row.appId).sort(), ids.slice(0, 6).sort());
});

test("fleet: projects that last answered over 24 hours ago are no evidence; the case opens", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  network(t, (host) => (host === SITE_HOST ? turtlSite404 : host === "shop0.example" ? () => (Date.now() >= at(1) ? down() : json(passed)) : host.endsWith(".example") ? down : null));
  warningsOf(t);
  const [alive, ...dead] = await fleet(w, 6);
  // Five projects whose apps last answered 25 hours ago, and have not answered since.
  for (const appId of dead) await w.db.insert("watchedProjects", { appId, lastAnsweredAt: START - 25 * HOUR, lastCheckedAt: START - 25 * HOUR });
  await minutes(t, w, 0, 6);
  assert.ok(notAnswering(w).some((row) => row.appId === alive), "the project that answered until a minute ago gets its case");
});

test("fleet: fewer than five other projects are no evidence; each case opens", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  network(t, (host) => (host === SITE_HOST ? turtlSite404 : host.endsWith(".example") ? () => (Date.now() >= at(1) ? down() : json(passed)) : null));
  warningsOf(t);
  const ids = await fleet(w, 5);
  await minutes(t, w, 0, 6);
  assert.deepEqual(notAnswering(w).map((row) => row.appId).sort(), [...ids].sort());
});

test("fleet: a round records when it last got a usable reply, in the write it already makes", async (t) => {
  const w = world(t);
  let answer = () => json(passed);
  network(t, (host) => (host === "shop.example" ? () => answer() : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 1);
  const row = () => w.rows("watchedProjects").find((one) => one.appId === appId);
  assert.deepEqual([row().lastAnsweredAt, row().lastCheckedAt], [at(0), at(0)]);
  answer = () => json(failed);
  await minutes(t, w, 1, 2);
  assert.equal(row().lastAnsweredAt, at(1), "a failing check is a usable reply");
  answer = down;
  await minutes(t, w, 2, 3);
  assert.deepEqual([row().lastAnsweredAt, row().lastCheckedAt], [at(1), at(2)]);
});

// ---- Finding 3: the demo with PROTECTED_APP_URL unset ----

test("R4, R9: when the demo's PROTECTED_APP_URL goes, a project with counts is no longer watched: its counts go and its case closes with why", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: "https://booking.example", PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  network(t, (host) => (host === "booking.example" ? down : null));
  const appId = await w.db.insert("apps", { name: "Booking demo", productionUrl: "https://booking.example" });
  await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: "v1", check: { kind: "http", config: { url: "https://booking.example/journey-check", method: "POST", expectedStatus: 200 } }, lastPassedAt: START - HOUR });
  await minutes(t, w, 0, 1);
  // What the demo's tick reads from its projects and checks with the address set.
  w.reads.length = 0;
  await minutes(t, w, 1, 2);
  const whenSet = w.reads.filter(([table]) => table === "apps" || table === "journeys").reduce((sum, [, , documents]) => sum + documents, 0);
  await minutes(t, w, 2, 4);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");

  delete process.env.PROTECTED_APP_URL;
  await minutes(t, w, 4, 5);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.equal(attempt.summary, "turtl stopped checking this project, so it closed this case without knowing whether the app answers again. turtl's checks are turned off for now, so turtl has nothing to check.");
  assert.deepEqual([events(w), counts(w, appId)], [["not_answering"], [0]]);
  assert.equal((await overview(w, appId, null))[0].notAnswering, undefined);
  // With nothing counted, a tick with the address unset reads no more than one with it set.
  w.reads.length = 0;
  assert.match((await w.run("internal.monitor.tick", {})).skipped, /PROTECTED_APP_URL is not set/);
  const whenUnset = w.reads.filter(([table]) => table === "apps" || table === "journeys").reduce((sum, [, , documents]) => sum + documents, 0);
  assert.ok(whenUnset <= whenSet, `${whenUnset} documents with it unset, ${whenSet} with it set`);
  assert.deepEqual(w.reads.filter(([table]) => !["apps", "journeys", "users", "authAccounts", "closedDemoNotices"].includes(table)), []);
});

// ---- Finding 4: an older result never overwrites a newer one ----

test("R2, R4: a round whose lease ran out and finishes after the next round cannot close the case with its old pass", async (t) => {
  const w = world(t);
  let mode = "down";
  let release;
  network(t, (host) => (host === "shop.example"
    ? () => (mode === "down" ? down() : new Promise((resolve) => { release = () => resolve(json(passed)); }))
    : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  await project(w, ada, "shop.example");
  await minutes(t, w, 0, 8);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");

  // Minute 20: round A starts; the app answers it (a pass), but round A stalls before it settles.
  t.mock.timers.setTime(at(20));
  await w.run("internal.monitor.tick", {});
  const index = w.scheduled.findIndex((job) => job.path === "internal.monitor.checkProject");
  const [roundAJob] = w.scheduled.splice(index, 1);
  mode = "slow-pass";
  const roundA = w.run(roundAJob.path, roundAJob.args);
  await new Promise((resolve) => setImmediate(resolve));
  // Down again; minute 26: A's lease has run out, so round B runs and finds the app down.
  mode = "down";
  t.mock.timers.setTime(at(26));
  await w.run("internal.monitor.tick", {});
  await w.drain(RUNS);
  const afterB = w.rows("journeys")[0].unanswered;
  assert.equal(afterB.at, at(26));
  // Round A finishes now with its minute-20 pass: older than what the check has on record, so it changes nothing.
  release();
  await roundA;
  await w.drain(RUNS);
  assert.equal(notAnswering(w)[0].status, "waiting_for_app");
  assert.deepEqual(w.rows("journeys")[0].unanswered, afterB);
  assert.deepEqual(pushes(w), ["not_answering"]);
  await minutes(t, w, 27, 60);
  assert.deepEqual(notAnswering(w).map((row) => row.status), ["waiting_for_app"], "the same outage, still one case");
  assert.deepEqual(pushes(w), ["not_answering"]);
});

test("R2: a direct round (as the practice review's setup makes) that finishes late cannot reorder results either", async (t) => {
  const w = world(t);
  let mode = "down";
  let release;
  network(t, (host) => (host === "shop.example" ? () => (mode === "down" ? down() : new Promise((resolve) => { release = () => resolve(json(passed)); })) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
  // A direct round at minute 6 gets a slow pass; the cron's round at minute 7 finds the app down and settles first.
  t.mock.timers.setTime(at(6));
  mode = "slow-pass";
  const direct = w.run("internal.monitor.checkProject", { appId });
  await new Promise((resolve) => setImmediate(resolve));
  mode = "down";
  await minutes(t, w, 7, 8);
  const after = w.rows("journeys")[0].unanswered;
  assert.equal(after.at, at(7));
  release();
  await direct;
  await w.drain(RUNS);
  assert.deepEqual([notAnswering(w).map((row) => row.status), w.rows("journeys")[0].unanswered, pushes(w)], [["waiting_for_app"], after, ["not_answering"]]);
  // And a miss older than the check's latest pass does not count.
  const [journey] = w.rows("journeys");
  await w.run("internal.monitor.recordPass", { journeyId: journey._id, observedAt: at(9) });
  await w.run("internal.protectedApp.notAnswering.settle", { appId, tries: [{ journeyId: journey._id, at: at(8), got: { kind: "no_response", timedOut: true } }] });
  assert.deepEqual(counts(w, appId), [0]);
});

// ---- Finding 10: the rules a mutation could break unnoticed ----

test("M1: a pass a case's verify step records closes the case when no other check is still not answering", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  t.mock.timers.setTime(at(5));
  const [journey] = w.rows("journeys");
  await w.run("internal.monitor.recordPass", { journeyId: journey._id, observedAt: at(5) });
  await w.drain(RUNS);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "resolved");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.match(attempt.summary, /^The app answered turtl's checks again after about 5 minutes without an answer\./);
  assert.deepEqual([events(w), counts(w, appId)], [["not_answering", "answering_again"], [0]]);
});

test("M2, V5: a verify step's pass closes the case, all passed only when no other check of the project has a count", async (t) => {
  for (const others of ["quiet", "clear"]) {
    await t.test(others, async (t) => {
      const w = world(t);
      network(t, (host) => (host === "shop.example" ? down : null));
      const ada = await w.db.insert("users", { email: "ada@example.com" });
      const appId = await project(w, ada, "shop.example", 2);
      await minutes(t, w, 0, 4);
      const [first, second] = w.rows("journeys");
      if (others === "clear") await w.db.patch(second._id, { unanswered: undefined });
      await w.run("internal.monitor.recordPass", { journeyId: first._id, observedAt: at(5) });
      const [closed] = notAnswering(w);
      assert.equal(closed.status, "resolved", "the app answered a case's own check");
      const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
      assert.equal(attempt.output.allPassed, others === "clear");
      assert.deepEqual(counts(w, appId), others === "clear" ? [0, 0] : [0, 3]);
    });
  }
});

test("M3: a project left with no check turtl can run loses its counts, and its case closes with why", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  const [journey] = w.rows("journeys");
  await w.db.patch(journey._id, { check: { kind: "revyl", config: { workflowId: "w-1" } } });
  await minutes(t, w, 4, 10);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === closed._id);
  assert.match(attempt.summary, /It has no checks turtl can run, so turtl has nothing to check\.$/);
  assert.deepEqual([events(w), counts(w, appId)], [["not_answering"], [0]]);
});

test("M4, M5: the daily limit holds in both places; at the limit turtl does not ask its own site, and the window runs out for cases turtl itself made", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE }, { clock: true });
  let up = true;
  const sent = network(t, (host) => (host === "shop.example" ? () => (up ? json(passed) : down()) : host === SITE_HOST ? turtlSite404 : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  const { NOT_ANSWERING_CASES_PER_DAY } = w.load("convex/protectedApp/notAnswering.ts");
  // The app flaps: down until a case opens, back until it closes, ten times.
  let minute = 0;
  const runUntil = async (done) => {
    while (!done()) {
      assert.ok(minute < 24 * 60, "ran out of day");
      await minutes(t, w, minute, minute + 1);
      minute++;
    }
  };
  for (let n = 1; n <= NOT_ANSWERING_CASES_PER_DAY; n++) {
    up = false;
    await runUntil(() => notAnswering(w).length === n);
    up = true;
    await runUntil(() => notAnswering(w).every((row) => row.status === "resolved"));
  }
  const first = notAnswering(w)[0]._creationTime;
  assert.ok(minute < 4 * 60, `ten cases in ${minute} minutes`);
  const askedAtLimit = sent.filter((request) => request.host === SITE_HOST).length;
  assert.equal(askedAtLimit, NOT_ANSWERING_CASES_PER_DAY, "turtl asked its own site once for each case");

  // Down again: no eleventh case today, and turtl does not ask its own site on every round.
  up = false;
  const end = Math.ceil((first + 24 * HOUR - START) / MINUTE);
  await minutes(t, w, minute, end - 1);
  assert.equal(notAnswering(w).length, NOT_ANSWERING_CASES_PER_DAY);
  assert.equal(sent.filter((request) => request.host === SITE_HOST).length, askedAtLimit);
  assert.ok(counts(w, appId)[0] >= 3, "the check is still not answering");
  // open() keeps the limit too, whoever calls it.
  assert.equal(await w.run("internal.protectedApp.notAnswering.open", { appId, ran: [w.rows("journeys")[0]._id], turtl: "reachable" }), null);
  assert.equal(notAnswering(w).length, NOT_ANSWERING_CASES_PER_DAY);

  // A day after the first, the window has room again: a round opens the eleventh.
  await minutes(t, w, end - 1, end + 20);
  assert.equal(notAnswering(w).length, NOT_ANSWERING_CASES_PER_DAY + 1);
  assert.ok(notAnswering(w).at(-1)._creationTime > first + 24 * HOUR);
});

test("M22: open() opens nothing for a check that did not run in the round", async (t) => {
  const w = world(t);
  network(t, () => null);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  const [journey] = w.rows("journeys");
  await w.db.patch(journey._id, { unanswered: { count: 3, since: at(-3), at: at(0), latest: { kind: "no_response", timedOut: false } } });
  assert.equal(await w.run("internal.protectedApp.notAnswering.open", { appId, ran: [], turtl: "reachable" }), null);
  assert.deepEqual(notAnswering(w), []);
});

// =====================================================================================================================
// Only a check that can stop answering counts: a journey-contract check (the monitor POSTs to it) that has passed at
// least once. Onboarding registers a project's health and readiness endpoints as journeys beside its real checks, and
// those never return a check result; nor does a check that has never passed, such as one aimed at a wrong address.
// =====================================================================================================================

/** Counts how often the end of a round reaches the not-answering decision (protectedApp/notAnswering.ts, settle). */
function settleCalls(w) {
  const module = w.load("convex/protectedApp/notAnswering.ts");
  const original = module.settle.handler;
  const calls = [];
  module.settle.handler = (ctx, args) => (calls.push(args), original(ctx, args));
  return calls;
}

test("never passed: health and readiness journeys that reply 200 with no result keep no count and open nothing, however many rounds; the turn settles nothing", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? (target) => (target.pathname === "/health" || target.pathname === "/ready" ? healthReply() : json(passed)) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await healthAndReadiness(w, appId, "shop.example");
  const calls = settleCalls(w);
  w.reads.length = 0;
  await minutes(t, w, 0, 180);
  assert.deepEqual(counts(w, appId), [0, 0, 0]);
  assert.deepEqual([notAnswering(w), events(w), pushes(w)], [[], [], []]);
  assert.deepEqual(calls, [], "no round reached the not-answering decision");
  assert.deepEqual(w.reads.filter(([table]) => table === "cases"), [], "and no case was read");
  // The overview shows them as before: passing since their registration, never "not answering".
  const shown = await overview(w, appId, ada);
  assert.deepEqual(shown.map((check) => [check.name, check.state, check.notAnswering]), [["Check 0", "passing", undefined], ["Health", "passing", undefined], ["Ready to serve", "passing", undefined]]);
  assert.equal(shown[1].lastPassedAt, START - HOUR);
});

test("never passed: when the app goes down only the real check counts, and the case names it alone; when the app is back it closes with its checks passing", async (t) => {
  const w = world(t);
  let up = true;
  network(t, (host) => (host === "shop.example" ? (target) => (!up ? down() : target.pathname === "/health" || target.pathname === "/ready" ? healthReply() : json(passed)) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await healthAndReadiness(w, appId, "shop.example");
  await minutes(t, w, 0, 3);
  up = false;
  await minutes(t, w, 3, 8);
  const [opened, ...more] = notAnswering(w);
  assert.deepEqual(more, []);
  assert.equal(opened.status, "waiting_for_app");
  assert.equal(opened.impact, 'At least three tries in a row of the "Check 0" check got no usable answer: turtl could not connect to the app.');
  assert.ok(!/Health|Ready/.test(opened.impact), opened.impact);
  assert.deepEqual(counts(w, appId), [3, 0, 0]);
  up = true;
  await minutes(t, w, 8, 60);
  assert.deepEqual(notAnswering(w).map((row) => row.status), ["resolved"], "closed, and never opened again");
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === opened._id);
  assert.match(attempt.summary, /Its checks pass now\.$/);
  assert.ok(!/Health|Ready|got no answer/.test(attempt.summary), attempt.summary);
  assert.deepEqual(events(w), ["not_answering", "answering_again"]);
  assert.deepEqual(counts(w, appId), [0, 0, 0]);
});

test("never passed: a check that has never passed and gets no response at all (a new project with a wrong address) opens nothing", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "wrong.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "wrong.example", 2, { passed: false });
  const calls = settleCalls(w);
  await minutes(t, w, 0, 120);
  assert.deepEqual([counts(w, appId), notAnswering(w), events(w), calls], [[0, 0], [], [], []]);
  assert.deepEqual((await overview(w, appId, ada)).map((check) => [check.state, check.notAnswering]), [["waiting", undefined], ["waiting", undefined]]);
});

test("never passed: the end of a round ignores a try of a check that cannot stop answering, even when handed one", async (t) => {
  const w = world(t);
  network(t, () => null);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 1, { passed: false });
  await healthAndReadiness(w, appId, "shop.example");
  const tries = w.rows("journeys").map((journey) => ({ journeyId: journey._id, at: at(0), got: { kind: "no_result", status: 200 } }));
  for (let n = 0; n < 4; n++) await w.run("internal.protectedApp.notAnswering.settle", { appId, tries: tries.map((one) => ({ ...one, at: at(n) })) });
  assert.deepEqual([counts(w, appId), notAnswering(w)], [[0, 0, 0], []]);
  // Counts such a check has on record (from before this rule) are not "not answering", and go at the next round.
  const [, health] = w.rows("journeys");
  await w.db.patch(health._id, { unanswered: { count: 9, since: at(-20), at: at(-1), latest: { kind: "no_result", status: 200 } } });
  assert.equal((await overview(w, appId, ada))[1].notAnswering, undefined);
  assert.equal(await w.run("internal.protectedApp.notAnswering.open", { appId, ran: [health._id], turtl: "reachable" }), null);
  await w.run("internal.protectedApp.notAnswering.settle", { appId, tries: [] });
  assert.deepEqual(counts(w, appId), [0, 0, 0]);
});

test("never passed, R9: the single-owner demo does the same", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: "https://booking.example", PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  let up = true;
  network(t, (host) => (host === "booking.example" ? (target) => (!up ? down() : target.pathname === "/health" || target.pathname === "/ready" ? healthReply() : json(passed)) : host === "new.example" ? down : null));
  const appId = await w.db.insert("apps", { name: "Booking demo", productionUrl: "https://booking.example" });
  await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: "v1", check: { kind: "http", config: { url: "https://booking.example/journey-check", method: "POST", expectedStatus: 200 } } });
  await healthAndReadiness(w, appId, "booking.example");
  // A second project whose one check has never passed: its address is wrong.
  const fresh = await w.db.insert("apps", { name: "New demo", productionUrl: "https://new.example" });
  await w.db.insert("journeys", { appId: fresh, name: "Book", description: ".", checkVersion: "v1", check: { kind: "http", config: { url: "https://new.example/journey-check", method: "POST", expectedStatus: 200 } } });
  const calls = settleCalls(w);
  await minutes(t, w, 0, 60);
  assert.deepEqual([counts(w, appId), counts(w, fresh), notAnswering(w), calls], [[0, 0, 0], [0], [], []]);
  up = false;
  await minutes(t, w, 60, 63);
  const [opened, ...more] = notAnswering(w);
  assert.deepEqual([more, opened.appId], [[], appId]);
  assert.match(opened.impact, /^At least three tries in a row of the "Book" check got no usable answer/);
  up = true;
  await minutes(t, w, 63, 64);
  const [attempt] = w.rows("stepAttempts").filter((row) => row.caseId === opened._id);
  assert.equal(notAnswering(w)[0].status, "resolved");
  assert.match(attempt.summary, /Its checks pass now\.$/);
  assert.deepEqual(events(w), ["not_answering", "answering_again"]);
});

// =====================================================================================================================
// Second revision (.claude/designs/2026-11-16-not-answering-cases.md, V1 to V6; the second review's G1 to G5). A case
// means what its title says: the app gives turtl nothing at all. A try is quiet only with no response, or a reply of
// 500 or more with no check result; any other reply means the app answered.
// =====================================================================================================================

/** Replies that show the app serving though turtl cannot run the check there (V1). */
const DRIFTED = [
  ["404", () => new Response("Not Found", { status: 404 })],
  ["401", () => json({ error: { code: "UNAUTHORIZED" } }, 401)],
  ["429", () => new Response("Slow down", { status: 429 })],
  ["a redirect", () => new Response("", { status: 302, headers: { Location: "https://elsewhere.example/" } })],
];
const closingOf = (w, caseId) => w.rows("stepAttempts").find((row) => row.caseId === caseId);
/** What a case says when it closes because its checks no longer get a reply turtl can read (W3). */
const CANNOT_TELL = "turtl closed this case because it can no longer tell whether the app answers: its checks no longer get a reply turtl can read.";
const appRow = (w, appId) => w.rows("apps").find((row) => row._id === appId);

test("W1, G1: a check whose route now answers 404, 401, 429 or a redirect keeps no count and opens nothing, alone or beside a passing check; a real outage then opens one case, which closes as answered beside a passing check and as turtl no longer able to tell alone", async (t) => {
  for (const [what, drifted] of DRIFTED) {
    for (const checks of [1, 2]) {
      await t.test(`${what}, ${checks === 1 ? "alone" : "beside a passing check"}`, async (t) => {
        const w = world(t);
        let appDown = false;
        network(t, (host) => (host === "shop.example" ? (target) => (appDown ? down() : target.pathname.startsWith("/check-0/") ? drifted() : json(passed)) : null));
        const ada = await w.db.insert("users", { email: "ada@example.com" });
        const appId = await project(w, ada, "shop.example", checks);
        const calls = settleCalls(w);
        await minutes(t, w, 0, 180);
        assert.ok(counts(w, appId).every((count) => count === 0), String(counts(w, appId)));
        assert.deepEqual([notAnswering(w), pushes(w), calls], [[], [], []], "three hours: no count, no case, nothing even settled");
        assert.ok((await overview(w, appId, ada)).every((check) => check.notAnswering === undefined));
        // The whole app goes down: one case, one push. It comes back: the case closes.
        appDown = true;
        await minutes(t, w, 180, 230);
        assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["waiting_for_app"], ["not_answering"]]);
        appDown = false;
        await minutes(t, w, 230, 260);
        if (checks === 2) {
          assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["resolved"], ["not_answering", "answering_again"]]);
        } else {
          // Its one check is unreadable again: turtl can no longer tell, closes the case and says nothing to the phone (W3).
          assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["unresolved"], ["not_answering"]]);
          assert.equal(closingOf(w, notAnswering(w)[0]._id).summary, CANNOT_TELL);
        }
        assert.equal(appRow(w, appId).notAnsweringCase, undefined);
      });
    }
  }
});

test("V4: one check quiet with a 5xx while another answers shows as not answering, opens no case and sends no push", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? (target) => (target.pathname.startsWith("/check-1/") ? new Response("Bad gateway", { status: 502 }) : json(passed)) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 120);
  assert.deepEqual([notAnswering(w), events(w), pushes(w)], [[], [], []]);
  assert.ok(counts(w, appId)[1] >= 3);
  assert.deepEqual((await overview(w, appId, ada)).map((check) => [check.state, check.notAnswering !== undefined]), [["passing", false], ["failing", true]]);
});

test("V1, V4: a single-check project whose check gets 502s opens a case that says what turtl saw", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? () => new Response("Bad gateway", { status: 502 }) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  await project(w, ada, "shop.example");
  await minutes(t, w, 0, 5);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  assert.equal(opened.impact, 'At least three tries in a row of the "Check 0" check got no usable answer: the app replied with HTTP 502 but no check result.');
  assert.deepEqual(pushes(w), ["not_answering"]);
});

test("W1, W2: a health check that is unreadable (a 405) or quiet beside a quiet journey check changes nothing about when the case opens", async (t) => {
  const openedAt = {};
  for (const health of ["none", "405", "quiet"]) {
    await t.test(health, async (t) => {
      const w = world(t);
      network(t, (host) => (host === "shop.example"
        ? (target) => (target.pathname === "/health" || target.pathname === "/ready"
          ? (health === "405" ? new Response("Method not allowed", { status: 405 }) : down())
          : Date.now() >= at(1) ? down() : json(passed))
        : null));
      const ada = await w.db.insert("users", { email: "ada@example.com" });
      const appId = await project(w, ada, "shop.example");
      if (health !== "none") await healthAndReadiness(w, appId, "shop.example");
      let minute = 0;
      while (!notAnswering(w).length) {
        assert.ok(minute < 60, "no case in an hour");
        await minutes(t, w, minute, ++minute);
      }
      openedAt[health] = minute;
      assert.match(notAnswering(w)[0].impact, /^At least three tries in a row of the "Check 0" check/, "it names the check that can stop answering");
      assert.deepEqual(pushes(w), ["not_answering"]);
    });
  }
  assert.deepEqual([openedAt["405"], openedAt.quiet], [openedAt.none, openedAt.none]);
});

test("W3, G2: with a case open and no countable check readable in the round (the control token removed), it closes as turtl no longer able to tell, with no notice, and is never stranded", async (t) => {
  const w = world(t);
  const { CREDENTIAL_REF } = w.load("convex/protectedApp/client.ts");
  let appDown = true;
  network(t, (host) => (host === "shop.example" ? (target) => (appDown ? down() : target.pathname.endsWith("/journey-check") ? json(passed) : healthReply()) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await w.db.insert("apps", { name: "Shop", ownerId: ada, repoUrl: "https://github.com/o/shop", productionUrl: "https://shop.example" });
  for (const n of [0, 1]) {
    await w.db.insert("journeys", { appId, name: `Book ${n}`, description: ".", checkVersion: "v1", lastPassedAt: START - HOUR, check: { kind: "http", config: { url: `https://shop.example/book-${n}/journey-check`, method: "POST", expectedStatus: 200, credentialRef: CREDENTIAL_REF } } });
  }
  await healthAndReadiness(w, appId, "shop.example");
  const seal = w.load("convex/secrets/seal.ts");
  const sealed = await seal.seal(`token-${appId}`, `turtl-secret:control_token:${appId}`, await seal.sealingKey(KEY));
  await w.db.insert("secrets", { kind: "control_token", account: ada, appId, sealed: sealed.sealed, keyId: sealed.keyId, setAt: START });
  await minutes(t, w, 0, 6);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  assert.equal(appRow(w, appId).notAnsweringCase, opened._id, "the project records its open case");

  await w.run("api.secrets.project.removeControlToken", { projectId: appId }, ada);
  const calls = settleCalls(w);
  await minutes(t, w, 6, 30);
  // Only the health and readiness checks run now, and they cannot stop answering: turtl can no longer tell.
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  assert.equal(closingOf(w, closed._id).summary, CANNOT_TELL);
  assert.deepEqual({ answered: closingOf(w, closed._id).output.answered, allPassed: closingOf(w, closed._id).output.allPassed }, { answered: false, allPassed: false });
  assert.equal(appRow(w, appId).notAnsweringCase, undefined, "and the project no longer records it");
  assert.deepEqual(calls.map((args) => args.tries.length), [2], "settled once, with the health and readiness tries as evidence");
  appDown = false;
  await minutes(t, w, 30, 90);
  assert.equal(calls.length, 1, "with nothing open, counted or quiet, a round settles nothing again");
  assert.deepEqual(events(w), ["not_answering"], "no 'answering again'");
});

test("V5, G2: with no check left to run at all (the control token removed, no health check), the case closes as turtl having stopped checking", async (t) => {
  const w = world(t);
  const { CREDENTIAL_REF } = w.load("convex/protectedApp/client.ts");
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await w.db.insert("apps", { name: "Shop", ownerId: ada, repoUrl: "https://github.com/o/shop", productionUrl: "https://shop.example" });
  await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: "v1", lastPassedAt: START - HOUR, check: { kind: "http", config: { url: "https://shop.example/journey-check", method: "POST", expectedStatus: 200, credentialRef: CREDENTIAL_REF } } });
  const seal = w.load("convex/secrets/seal.ts");
  const sealed = await seal.seal(`token-${appId}`, `turtl-secret:control_token:${appId}`, await seal.sealingKey(KEY));
  await w.db.insert("secrets", { kind: "control_token", account: ada, appId, sealed: sealed.sealed, keyId: sealed.keyId, setAt: START });
  await minutes(t, w, 0, 6);
  assert.equal(notAnswering(w)[0]?.status, "waiting_for_app");
  await w.run("api.secrets.project.removeControlToken", { projectId: appId }, ada);
  // The count is gone before the next turn, so only the project's record of its open case can tell turtl to stop it.
  const [journey] = w.rows("journeys");
  await w.db.patch(journey._id, { unanswered: undefined });
  await minutes(t, w, 6, 30);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  assert.match(closingOf(w, closed._id).summary, /^turtl stopped checking this project, so it closed this case without knowing whether the app answers again\. No control token is set/);
  assert.deepEqual([events(w), appRow(w, appId).notAnsweringCase], [["not_answering"], undefined]);
});

test("V5: the project's record of its open case is mended when the case was closed some other way", async (t) => {
  const w = world(t);
  let up = false;
  network(t, (host) => (host === "shop.example" ? () => (up ? json(passed) : down()) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  const [opened] = notAnswering(w);
  assert.equal(appRow(w, appId).notAnsweringCase, opened._id);
  // As the dev tools' reset or account deletion decline every open case.
  await w.db.patch(opened._id, { status: "declined" });
  up = true;
  await minutes(t, w, 4, 10);
  assert.equal(appRow(w, appId).notAnsweringCase, undefined);
});

test("W1, W3, H2: an unreadable reply during an outage neither closes the case nor says anything; when the app is back, the summary and allPassed ignore it", async (t) => {
  const w = world(t);
  let health = "down";
  let appUp = false;
  network(t, (host) => (host === "shop.example"
    ? (target) => (target.pathname === "/health" || target.pathname === "/ready"
      ? (health === "429" ? new Response("Too Many Requests", { status: 429 }) : health === "page" ? healthReply() : down())
      : appUp ? json(passed) : down())
    : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await healthAndReadiness(w, appId, "shop.example");
  await minutes(t, w, 0, 5);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  // The edge answers the health checks (a firewall's 429, then a page) while the app is still down.
  health = "429";
  await minutes(t, w, 5, 20);
  health = "page";
  await minutes(t, w, 20, 40);
  assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["waiting_for_app"], ["not_answering"]], "still down: no 'answering again'");
  appUp = true;
  await minutes(t, w, 40, 60);
  const closing = closingOf(w, opened._id);
  assert.equal(notAnswering(w)[0].status, "resolved");
  assert.deepEqual({ answered: closing.output.answered, allPassed: closing.output.allPassed }, { answered: true, allPassed: true });
  assert.match(closing.summary, /Its checks pass now\.$/);
  assert.ok(!/Health|Ready/.test(closing.summary), closing.summary);
  assert.deepEqual(pushes(w), ["not_answering", "answering_again"]);
});

test("V3, V5, G4a: a failing check that has never passed is evidence; the case closes with allPassed false and says it fails", async (t) => {
  const w = world(t);
  let appDown = false;
  network(t, (host) => (host === "shop.example" ? (target) => (appDown ? down() : target.pathname.startsWith("/prevent/") ? json(failed, 503) : json(passed)) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 1);
  // As convex/structural/checks.ts registers a prevention check whose first run failed: POST, never passed.
  await w.db.insert("journeys", { appId, name: "Booking survives a slow store", description: ".", checkVersion: "journey-check-v1+slow_store", check: { kind: "http", config: { url: "https://shop.example/prevent/journey-check?scenario=slow_store", method: "POST", expectedStatus: 200 } } });
  await minutes(t, w, 0, 1);
  appDown = true;
  await minutes(t, w, 1, 6);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  appDown = false;
  await minutes(t, w, 6, 30);
  const closing = closingOf(w, opened._id);
  assert.equal(closing.output.allPassed, false);
  assert.match(closing.summary, /"Booking survives a slow store" fails now, which turtl handles as a separate issue\.$/);
});

// ---- V6: the fleet check ----

test("V6, G3: a practice project in the fleet is no evidence; turtl losing the internet still holds every owner's case", async (t) => {
  const w = world(t, OWN_SITE);
  let egress = true;
  network(t, (host) => (host === SITE_HOST
    ? (target) => (target.pathname.startsWith("/practice/") ? json(passed) : turtlSite404())
    : () => (egress ? json(passed) : down())));
  warningsOf(t);
  for (let n = 0; n < 8; n++) await project(w, await w.db.insert("users", { email: `owner${n}@example.com` }), `shop${n}.example`);
  const practiceOwner = await w.db.insert("users", { email: "newcomer@example.com" });
  const practiceId = await practiceProject(w, practiceOwner);
  await w.db.patch(w.rows("journeys").find((row) => row.appId === practiceId)._id, { lastPassedAt: START - HOUR });
  await minutes(t, w, 0, 2);
  egress = false;
  await minutes(t, w, 2, 20);
  assert.deepEqual([notAnswering(w), pushes(w)], [[], []], "held: the practice app answering is turtl's own site, not the internet");
  assert.equal(w.rows("watchedProjects").find((row) => row.appId === practiceId).lastAnsweredAt, undefined, "a practice round is never recorded as evidence");
});

/** Rounds once a minute with monitor rows seeded after each claim (so the monitor never takes their turns) and removed after. */
async function withRows(t, w, from, to, rows) {
  for (let minute = from; minute < to; minute++) {
    t.mock.timers.setTime(at(minute));
    await w.run("internal.monitor.tick", {});
    const ids = [];
    for (const row of rows(Date.now())) ids.push(await w.db.insert("watchedProjects", row));
    await w.drain(RUNS);
    for (const id of ids) await w.db.delete(id);
  }
}

test("V6, G5: with the fleet sample stuffed with forty quiet rows, a hold still ends once the project has been quiet for 30 minutes", async (t) => {
  const w = world(t, OWN_SITE);
  network(t, (host) => (host === SITE_HOST ? turtlSite404 : down));
  const warnings = warningsOf(t);
  await project(w, await w.db.insert("users", { email: "victim@example.com" }), "victim.example");
  const stuffed = (now) => [
    ...Array.from({ length: 40 }, (_, n) => ({ appId: `apps:quiet-${n}`, nextCheckAt: now - 20_000 - n, lastCheckedAt: now - 20_000, lastAnsweredAt: now - 20 * MINUTE })),
    ...Array.from({ length: 200 }, (_, n) => ({ appId: `apps:healthy-${n}`, nextCheckAt: now + 30_000 + n, lastCheckedAt: now - 30_000, lastAnsweredAt: now - 30_000 })),
  ];
  await withRows(t, w, 0, 29, stuffed);
  assert.deepEqual(notAnswering(w), [], "held while the project has been quiet under half an hour");
  assert.ok(warnings.some((line) => /other projects/.test(line)));
  await withRows(t, w, 29, 32, stuffed);
  assert.equal(notAnswering(w).length, 1, "then it opens, whatever the sample says");
});

test("N9: the fleet counts only projects checked since this one went quiet", async (t) => {
  const w = world(t, OWN_SITE);
  let up = true;
  network(t, (host) => (host === SITE_HOST ? turtlSite404 : host === "shop.example" ? () => (up ? json(passed) : down()) : null));
  warningsOf(t);
  await project(w, await w.db.insert("users", { email: "ada@example.com" }), "shop.example");
  await minutes(t, w, 0, 1);
  up = false;
  // Five other projects whose latest rounds got no reply, but were last checked before this one went quiet (minute 1).
  const before = (now) => Array.from({ length: 6 }, (_, n) => ({ appId: `apps:earlier-${n}`, nextCheckAt: now + 60_000 + n, lastCheckedAt: at(1) - 30_000, lastAnsweredAt: at(1) - 60_000 }));
  await withRows(t, w, 1, 6, before);
  assert.equal(notAnswering(w).length, 1, "they say nothing about the minutes since, so the case opens");
});

test("N22: the single-owner demo does not ask the fleet", async (t) => {
  const w = world(t, { PROTECTED_APP_URL: "https://booking.example", PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
  let up = true;
  network(t, (host) => (host === "booking.example" ? () => (up ? json(passed) : down()) : null));
  const warnings = warningsOf(t);
  const appId = await w.db.insert("apps", { name: "Booking demo", productionUrl: "https://booking.example" });
  await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: "v1", lastPassedAt: START - HOUR, check: { kind: "http", config: { url: "https://booking.example/journey-check", method: "POST", expectedStatus: 200 } } });
  // Rows that would hold the case if the demo asked the fleet (the demo itself never makes or claims such rows).
  for (let n = 0; n < 6; n++) await w.db.insert("watchedProjects", { appId: `apps:other-${n}`, nextCheckAt: at(120), lastCheckedAt: at(2), lastAnsweredAt: at(0) });
  await minutes(t, w, 0, 1);
  up = false;
  await minutes(t, w, 1, 5);
  assert.equal(notAnswering(w).length, 1);
  assert.ok(!warnings.some((line) => /other projects/.test(line)));
});

// ---- The rules the mutation run over V1 to V6 found unpinned ----

test("V4: no case while one countable check is quiet below three, though another is at three; then one opens", async (t) => {
  const w = world(t, { ...ACCOUNTS, CONVEX_SITE_URL: SITE });
  let checkOneUp = true;
  const sent = network(t, (host) => (host === SITE_HOST ? turtlSite404 : host === "shop.example" ? (target) => (target.pathname.startsWith("/check-1/") && checkOneUp ? json(passed) : down()) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  assert.deepEqual([counts(w, appId), notAnswering(w)], [[4, 0], []], "check 1 answered every round");
  checkOneUp = false;
  await minutes(t, w, 4, 6);
  assert.ok(counts(w, appId)[0] >= 3 && counts(w, appId)[1] < 3, String(counts(w, appId)));
  assert.deepEqual(notAnswering(w), [], "check 1 has only just gone quiet");
  assert.deepEqual(sent.filter((request) => request.host === SITE_HOST), [], "no case would open, so turtl did not even ask its own site");
  await minutes(t, w, 6, 12);
  assert.equal(notAnswering(w).length, 1, "both at three: one case");
  assert.equal(sent.filter((request) => request.host === SITE_HOST).length, 1);
});

test("V4: open() opens nothing while any check that ran is below three", async (t) => {
  const w = world(t);
  network(t, () => null);
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  const [first, second] = w.rows("journeys");
  await w.db.patch(first._id, { unanswered: { count: 3, since: at(-3), at: at(0), latest: { kind: "no_response", timedOut: false } } });
  await w.db.patch(second._id, { unanswered: { count: 1, since: at(0), at: at(0), latest: { kind: "no_response", timedOut: false } } });
  assert.equal(await w.run("internal.protectedApp.notAnswering.open", { appId, ran: [first._id, second._id], turtl: "reachable" }), null);
  assert.deepEqual(notAnswering(w), []);
});

test("V5: a verify step's pass of a check with no count still closes the open case", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await minutes(t, w, 0, 4);
  const [first, second] = w.rows("journeys");
  await w.db.patch(second._id, { unanswered: undefined });
  await w.run("internal.monitor.recordPass", { journeyId: second._id, observedAt: at(5) });
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "resolved");
  assert.equal(closingOf(w, closed._id).output.allPassed, false, "the other check still has its count");
  assert.deepEqual(counts(w, appId), [3, 0]);
  assert.ok(first);
});

test("V5: an open case with no count behind it closes as turtl having stopped checking when nothing is left to run", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? down : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  const [journey] = w.rows("journeys");
  await w.db.patch(journey._id, { unanswered: undefined, check: { kind: "revyl", config: { workflowId: "w-1" } } });
  await minutes(t, w, 4, 12);
  const [closed] = notAnswering(w);
  assert.equal(closed.status, "unresolved");
  assert.match(closingOf(w, closed._id).summary, /It has no checks turtl can run, so turtl has nothing to check\.$/);
  assert.equal(appRow(w, appId).notAnsweringCase, undefined);
});

test("V5, R9: in the single-owner demo an open case with no count behind it is still settled, and still stopped", async (t) => {
  for (const ending of ["answers", "loses its address", "checks turned off"]) {
    await t.test(ending, async (t) => {
      const w = world(t, { PROTECTED_APP_URL: "https://booking.example", PROTECTED_APP_CONTROL_SECRET: "demo-secret" });
      let up = false;
      network(t, (host) => (host === "booking.example" ? () => (up ? json(passed) : down()) : null));
      const appId = await w.db.insert("apps", { name: "Booking demo", productionUrl: "https://booking.example" });
      await w.db.insert("journeys", { appId, name: "Book", description: ".", checkVersion: "v1", lastPassedAt: START - HOUR, check: { kind: "http", config: { url: "https://booking.example/journey-check", method: "POST", expectedStatus: 200 } } });
      await minutes(t, w, 0, 4);
      const [opened] = notAnswering(w);
      assert.equal(opened?.status, "waiting_for_app");
      const [journey] = w.rows("journeys");
      await w.db.patch(journey._id, { unanswered: undefined });
      if (ending === "answers") up = true;
      if (ending === "loses its address") await w.db.patch(appId, { productionUrl: undefined });
      if (ending === "checks turned off") delete process.env.PROTECTED_APP_URL;
      await minutes(t, w, 4, 6);
      assert.equal(notAnswering(w)[0].status, ending === "answers" ? "resolved" : "unresolved");
      assert.equal(appRow(w, appId).notAnsweringCase, undefined);
    });
  }
});

// =====================================================================================================================
// Third revision (the design's W1 to W3; the third review's H1 to H3). Only a check result shows the app is serving. A
// reply below 500 with no result is unreadable: it proves nothing either way, so it counts for nothing either way.
// =====================================================================================================================

const BAD_GATEWAY = () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } });

/** Runs the monitor until a not-answering case exists, from `from`; returns the minute after the one that opened it. */
async function untilCase(t, w, from, limit = 60) {
  let minute = from;
  while (!notAnswering(w).some((row) => row.status === "waiting_for_app")) {
    assert.ok(minute < from + limit, `no case within ${limit} minutes`);
    await minutes(t, w, minute, ++minute);
  }
  return minute;
}

test("W1, H1a: the proxy answers /health itself while the app behind it is down for a day; a case opens in three rounds on the quiet checks, with one push", async (t) => {
  const w = world(t);
  let backendDown = false;
  network(t, (host) => (host === "shop.example"
    ? (target) => {
      // nginx: location = /health { return 200 "ok"; }, answered by the proxy whether or not the app is there.
      if (target.pathname === "/health") return new Response("ok", { status: 200 });
      if (backendDown) return BAD_GATEWAY();
      return target.pathname === "/ready" ? healthReply() : json(passed);
    }
    : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example", 2);
  await healthAndReadiness(w, appId, "shop.example");
  await minutes(t, w, 0, 2);
  backendDown = true;
  const opened = await untilCase(t, w, 2);
  assert.ok(opened - 2 <= 4, `opened ${opened - 2} minutes after the app went down`);
  assert.deepEqual(counts(w, appId).slice(0, 2), [3, 3], "on its third quiet round");
  assert.equal(notAnswering(w)[0].impact, 'At least three tries in a row of each of 2 checks ("Check 0" and "Check 1") got no usable answer: the app replied with HTTP 502 but no check result.');
  await minutes(t, w, opened, 24 * 60);
  assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["waiting_for_app"], ["not_answering"]], "one case and one push for a day down");
});

test("W1, H1b: a front layer answers one check by itself (a 200 page, a 404, a redirect) while the app behind it is down for a day; a case opens in three rounds on the other check, with one push", async (t) => {
  for (const [what, edge] of [
    ["a 200 page", () => new Response("<html>Welcome</html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["a 404", () => new Response("Not Found", { status: 404 })],
    ["a redirect", () => new Response("", { status: 302, headers: { Location: "https://login.example/" } })],
  ]) {
    await t.test(what, async (t) => {
      const w = world(t);
      let apiDown = false;
      network(t, (host) => (host === "shop.example" ? (target) => (target.pathname.startsWith("/check-1/") ? edge() : apiDown ? BAD_GATEWAY() : json(passed)) : null));
      const ada = await w.db.insert("users", { email: "ada@example.com" });
      const appId = await project(w, ada, "shop.example", 2);
      await minutes(t, w, 0, 2);
      assert.deepEqual([counts(w, appId), notAnswering(w)], [[0, 0], []]);
      apiDown = true;
      const opened = await untilCase(t, w, 2);
      assert.ok(opened - 2 <= 4, `opened ${opened - 2} minutes after the app went down`);
      assert.equal(notAnswering(w)[0].impact, 'At least three tries in a row of the "Check 0" check got no usable answer: the app replied with HTTP 502 but no check result.');
      await minutes(t, w, opened, 24 * 60);
      assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["waiting_for_app"], ["not_answering"]]);
    });
  }
});

test("W3: the app comes back behind a rotated token (401): the case closes as turtl no longer able to tell, with no push and the record cleared; down again, a new case opens after three quiet rounds", async (t) => {
  const w = world(t);
  let state = "down";
  network(t, (host) => (host === "shop.example" ? () => (state === "401" ? json({ error: { code: "UNAUTHORIZED" } }, 401) : down()) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 4);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  state = "401";
  await minutes(t, w, 4, 60);
  const [closed, ...more] = notAnswering(w);
  assert.deepEqual([closed.status, more], ["unresolved", []]);
  const closing = closingOf(w, closed._id);
  assert.equal(closing.summary, CANNOT_TELL);
  assert.deepEqual({ answered: closing.output.answered, allPassed: closing.output.allPassed }, { answered: false, allPassed: false });
  assert.deepEqual([pushes(w), events(w), appRow(w, appId).notAnsweringCase, counts(w, appId)], [["not_answering"], ["not_answering"], undefined, [0]]);
  state = "down";
  const reopened = await untilCase(t, w, 60);
  assert.ok(reopened - 60 <= 16, `reopened ${reopened - 60} minutes later`);
  assert.deepEqual(counts(w, appId), [3]);
  assert.deepEqual([notAnswering(w).map((row) => row.status), pushes(w)], [["unresolved", "waiting_for_app"], ["not_answering", "not_answering"]]);
});

test("W2, W3: a check that has never passed and returns a result closes an open case, and keeps a new one from opening", async (t) => {
  const w = world(t);
  let prevent = "down";
  network(t, (host) => (host === "shop.example" ? (target) => (target.pathname.startsWith("/prevent/") ? (prevent === "failing" ? json(failed, 503) : down()) : down()) : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await w.db.insert("journeys", { appId, name: "Booking survives a slow store", description: ".", checkVersion: "journey-check-v1+slow_store", check: { kind: "http", config: { url: "https://shop.example/prevent/journey-check?scenario=slow_store", method: "POST", expectedStatus: 200 } } });
  await minutes(t, w, 0, 4);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  prevent = "failing";
  await minutes(t, w, 4, 90);
  const [closed, ...more] = notAnswering(w);
  assert.deepEqual([closed.status, more], ["resolved", []], "closed by the result, and no new case though the other check stays quiet");
  assert.ok(counts(w, appId)[0] >= 3);
  assert.equal(closingOf(w, closed._id).output.allPassed, false);
  assert.deepEqual(pushes(w), ["not_answering", "answering_again"]);
});

test("W3, H3: a verify step's pass observed before the case opened leaves it open; one observed after closes it", async (t) => {
  const w = world(t);
  network(t, (host) => (host === "shop.example" ? BAD_GATEWAY : null));
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  await minutes(t, w, 0, 6);
  const [opened] = notAnswering(w);
  assert.equal(opened?.status, "waiting_for_app");
  const [journey] = w.rows("journeys").filter((row) => row.appId === appId);
  // A verify step that started 20 s before the first quiet try reports its pass now.
  await w.run("internal.monitor.recordPass", { journeyId: journey._id, observedAt: at(0) - 20_000 });
  await w.drain(RUNS);
  assert.equal(notAnswering(w)[0].status, "waiting_for_app", "a pass from before the case opened says nothing about since");
  assert.ok(counts(w, appId)[0] >= 3, "and does not clear the newer quiet tries");
  assert.deepEqual(pushes(w), ["not_answering"]);
  t.mock.timers.setTime(at(6));
  await w.run("internal.monitor.recordPass", { journeyId: journey._id, observedAt: at(6) });
  await w.drain(RUNS);
  assert.equal(notAnswering(w)[0].status, "resolved");
  assert.deepEqual(pushes(w), ["not_answering", "answering_again"]);
});
