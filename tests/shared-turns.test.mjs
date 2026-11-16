import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createBackend, createLoader } from "./fixtures/convex-backend.mjs";

// Second security review, finding 15: shared crons gave every row a turn in one fixed order, so rows anyone can create
// pushed back everyone else's. Each test here performs the attack against the real modules, on an in-memory copy of
// every table, at the scale the review names, and checks the victim's row is still served on time.

const KEY = randomBytes(32).toString("base64");
const ACCOUNTS = { AUTH_REQUIRED: "true", SECRETS_ENCRYPTION_KEY: KEY };
const VARIABLES = ["AUTH_REQUIRED", "SECRETS_ENCRYPTION_KEY", "PROTECTED_APP_URL", "PROTECTED_APP_CONTROL_SECRET", "CAPY_API_KEY", "WATCHED_APP_ALLOW_LOOPBACK", "CONVEX_CLOUD_URL", "OPENAI_API_KEY", "GITHUB_TOKEN"];
const START = Date.parse("2026-11-16T10:00:00Z");
const MINUTE = 60_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const passed = { runId: "run-1", verdict: "passed", failedStep: null, error: null, steps: [], cleanup: { ok: true, deletedBookings: 0 }, revision: "abc1234", environment: "test", startedAt: 1, completedAt: 2 };
const failed = { ...passed, verdict: "failed", failedStep: "save_booking", error: { code: "STORE_DOWN", message: "The store is down." } };

/** A stand-in for every outside address: answers by host, records every request with the minute it was sent at. */
function network(t, answers) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    sent.push({ host: target.host, path: target.pathname, at: Date.now() });
    return (answers[target.host] ?? (() => json({ ok: true })))(target, init);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

function world(t, env = ACCOUNTS, mocks = {}) {
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
    // A case the monitor opens is a row; the rest of the incident run is not under test here.
    "convex/runner/run": {
      startCaseRun: async (ctx, args) => ctx.db.insert("cases", { appId: args.appId, journeyId: args.journeyId, title: args.title, impact: args.impact, kind: args.kind, raisedBy: args.raisedBy, status: "investigating", signature: args.signature }),
      approveCase: async () => {},
      declineCase: async () => {},
    },
    ...mocks,
  });
  return { load, ...createBackend(load) };
}

/** A project on its own https origin with `checks` checks that need no control token. */
async function project(w, owner, host, checks = 1) {
  const appId = await w.db.insert("apps", { name: host, ownerId: owner, repoUrl: `https://github.com/${owner}/${host}`, productionUrl: `https://${host}` });
  for (let n = 0; n < checks; n++) {
    await w.db.insert("journeys", { appId, name: `Check ${n}`, description: ".", checkVersion: "v1", check: { kind: "http", config: { url: `https://${host}/check-${n}/journey-check`, method: "POST", expectedStatus: 200 } } });
  }
  return appId;
}

const at = (minute) => START + minute * MINUTE;

// ---- Statement 5: the monitor ----

test("ATTACK (finding 15): with 1,000 projects that have nothing to check and 100 whose address hangs, a healthy project is still checked every minute", async (t) => {
  const w = world(t);
  network(t, { "alice.example": () => json(passed) });
  const alice = await w.db.insert("users", { email: "alice@example.com" });
  const aliceApp = await project(w, alice, "alice.example");
  // 100 accounts at their cap of 10 projects, none with anything to check.
  for (let n = 0; n < 1000; n++) {
    const owner = n % 10 === 0 ? await w.db.insert("users", { email: `mallory${n / 10}@example.com` }) : null;
    await w.db.insert("apps", { name: `empty-${n}`, ownerId: owner ?? w.rows("users").at(-1)._id, repoUrl: "https://github.com/m/x" });
  }
  // 100 projects whose live address never answers: their checks run until the time limit, holding their turn.
  const mallory = w.rows("users").at(-1)._id;
  const hanging = [];
  for (let n = 0; n < 100; n++) hanging.push(await project(w, mallory, `hang-${n}.example`, 25));

  const turns = [];
  for (let minute = 0; minute < 30; minute++) {
    t.mock.timers.setTime(at(minute));
    const swept = await w.run("internal.monitor.tick", {});
    if (swept.started.includes(aliceApp)) turns.push(minute);
    // Every check is its own action, so Alice's runs while the hanging ones are still running.
    await w.drain(["internal.monitor.checkProject"], (job) => job.args.appId === aliceApp);
  }
  assert.deepEqual(turns, Array.from({ length: 30 }, (_, minute) => minute), "Alice's app was checked every minute");
  // The empty projects never took a turn, and were never read by the monitor.
  assert.equal(w.rows("watchedProjects").length, 101, "a row for each project with checks, and none for the empty ones");
  assert.equal(w.reads.filter(([table, index]) => table === "apps" && index === "by_creation_time").length, 0, "no sweep over every project");
  // The hanging projects kept their turn until their check's time limit, then got another; none was started twice at once.
  const hangingStarts = w.scheduled.filter((job) => job.path === "internal.monitor.checkProject" && hanging.includes(job.args.appId));
  assert.equal(hangingStarts.length, 100 * 6, "each hanging project started once per five-minute time limit over 30 minutes");
});

test("ATTACK (finding 15): new projects with checks join at once, however many projects came before them", async (t) => {
  const w = world(t);
  network(t, {});
  const owner = await w.db.insert("users", { email: "many@example.com" });
  for (let n = 0; n < 1000; n++) await w.db.insert("apps", { name: `empty-${n}`, ownerId: owner, repoUrl: "https://github.com/m/x" });
  await w.run("internal.monitor.tick", {});
  t.mock.timers.setTime(at(1));
  const late = await project(w, owner, "late.example");
  assert.deepEqual((await w.run("internal.monitor.tick", {})).started, [late], "the project made last is checked at the next tick");
});

test("with accounts off, the demo's monitor is unchanged and reads no turn order", async (t) => {
  const w = world(t, {});
  network(t, {});
  assert.deepEqual(await w.run("internal.monitor.tick", {}), { skipped: "PROTECTED_APP_URL is not set on this deployment, so no journey was checked." });
  assert.equal(w.reads.filter(([table]) => table === "watchedProjects" || table === "monitorCursor").length, 0);
});

// ---- Statement 6: an app that keeps failing the same way, and an address that is not the owner's ----

/** Runs the monitor minute by minute, every check to completion, and returns the minutes at which `host` was asked. */
async function minutesAsked(t, w, sent, host, from, to) {
  for (let minute = from; minute < to; minute++) {
    t.mock.timers.setTime(at(minute));
    await w.run("internal.monitor.tick", {});
    await w.drain(["internal.monitor.checkProject"]);
  }
  return [...new Set(sent.filter((request) => request.host === host && request.at >= at(from) && request.at < at(to)).map((request) => (request.at - START) / MINUTE))];
}

test("ATTACK (finding 15): an account points its live app at someone else's site; turtl's checks there slow to once every 15 minutes", async (t) => {
  const w = world(t);
  // The other site answers turtl's check with its own page: no verdict, the same failure every time.
  let site = () => new Response("<html>Someone else's shop</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  const sent = network(t, { "victim.example": (...args) => site(...args) });
  const mallory = await w.db.insert("users", { email: "mallory@example.com" });
  const appId = await project(w, mallory, "victim.example", 25);

  const day = await minutesAsked(t, w, sent, "victim.example", 0, 24 * 60);
  assert.deepEqual(day.slice(0, 8), [0, 1, 3, 7, 15, 30, 45, 60], "every minute, then 2, 4, 8 and 15 minutes apart");
  assert.ok(day.every((minute, i) => i === 0 || minute - day[i - 1] <= 15), "never more than 15 minutes apart");
  const requests = sent.filter((request) => request.host === "victim.example").length;
  assert.equal(day.length, 99, "99 checks in a day instead of 1,440");
  assert.equal(requests, 99 * 25, "each check asks its 25 addresses once");
  console.log(`one project aimed at another site: ${day.length} checks and ${requests} requests a day (was 1,440 checks and ${1440 * 25})`);

  // The owner taps Check again: the next tick checks it, and the pace starts over from every minute.
  await w.db.insert("onboardingPreparations", { appId, neverBreak: [], mergedAt: at(0), settledAt: at(0), repo: "mallory/victim", registration: { status: "registered", checks: [] } });
  t.mock.timers.setTime(at(24 * 60) + 5_000);
  await w.run("api.onboarding.projects.checkAgain", { projectId: appId }, mallory);
  assert.deepEqual(await minutesAsked(t, w, sent, "victim.example", 24 * 60 + 1, 24 * 60 + 9), [24 * 60 + 1, 24 * 60 + 2, 24 * 60 + 4, 24 * 60 + 8]);
  // Check again is itself limited to once every two minutes.
  t.mock.timers.setTime(at(24 * 60 + 10));
  await w.run("api.onboarding.projects.checkAgain", { projectId: appId }, mallory);
  t.mock.timers.setTime(at(24 * 60 + 11));
  await assert.rejects(w.run("api.onboarding.projects.checkAgain", { projectId: appId }, mallory), /less than 2 minutes ago/);

  // A pass puts it back to every minute at once.
  site = () => json(passed);
  const after = await minutesAsked(t, w, sent, "victim.example", 24 * 60 + 11, 24 * 60 + 20);
  assert.deepEqual(after.slice(-5), [24 * 60 + 15, 24 * 60 + 16, 24 * 60 + 17, 24 * 60 + 18, 24 * 60 + 19]);
  assert.equal(w.rows("watchedProjects")[0].failure, undefined);
});

test("an owner's own app that keeps failing slows the same way, a new failure is checked at once, and a pass restores the pace", async (t) => {
  const w = world(t);
  let answer = () => json(failed);
  const sent = network(t, { "shop.example": (...args) => answer(...args) });
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  assert.deepEqual(await minutesAsked(t, w, sent, "shop.example", 0, 16), [0, 1, 3, 7, 15]);
  assert.equal(w.rows("cases").length, 1, "the failure opened one case, and the slower checks open no more");
  // Failing another way is news: the very next check is a minute later.
  answer = () => json({ ...failed, failedStep: "confirm_booking", error: { code: "TIMEOUT", message: "." } });
  assert.deepEqual(await minutesAsked(t, w, sent, "shop.example", 16, 33), [30, 31]);
  answer = () => json(passed);
  assert.deepEqual(await minutesAsked(t, w, sent, "shop.example", 33, 38), [33, 34, 35, 36, 37]);
  assert.equal(w.rows("watchedProjects").find((row) => row.appId === appId).failure, undefined);
});

test("a practice app is still checked at once when made or broken, whatever pace its project was at", async (t) => {
  const w = world(t);
  const sent = network(t, { "practice.example": () => json(failed) });
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "practice.example");
  await w.db.patch(appId, { practice: true });
  await minutesAsked(t, w, sent, "practice.example", 0, 8);
  const row = w.rows("watchedProjects")[0];
  assert.ok(row.nextCheckAt > at(8), "it was spaced out");
  // What convex/practice/projects.ts runs after making the practice app, and after each break.
  t.mock.timers.setTime(at(8) + 1_000);
  await w.run("internal.practice.projects.firstCheck", { appId });
  assert.deepEqual(w.scheduled.filter((job) => job.path === "internal.monitor.checkProject").map((job) => job.args.appId), [appId], "its check started at once");
});
