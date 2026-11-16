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

// ---- Statement 7: following pull requests and preparations ----

/** A world whose GitHub access records each repository a read reached for, and goes no further. */
function following(t, env = ACCOUNTS) {
  const reached = [];
  const w = world(t, env, {
    "convex/github/access": {
      repositoryAccess: async (_ctx, repo) => (reached.push({ repo, at: Date.now() }), { ok: false, reason: "not_connected", message: `${repo} is not connected.` }),
    },
  });
  network(t, {});
  return { w, reached };
}

const DAY = 24 * 60 * MINUTE;

/** Runs the pull-request cron every 30 seconds from `from` to `to`, each claimed read to completion. */
async function followPullRequests(t, w, from, to) {
  for (let now = from; now < to; now += 30_000) {
    t.mock.timers.setTime(now);
    await w.run("internal.pullRequests.refreshActive", {});
    await w.drain(["internal.pullRequests.syncDue"]);
  }
}

const aCase = (w, appId) => w.db.insert("cases", { appId, title: "x", impact: "x", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" });

test("ATTACK (finding 15): with 1,000 open pull requests on another account, all due at once, Alice's is read within a minute", async (t) => {
  const { w, reached } = following(t);
  const mallorys = await aCase(w, "apps:0");
  for (let n = 1; n <= 1000; n++) {
    await w.db.insert("pullRequests", { caseId: mallorys, source: "attached", repo: "mallory/forever", number: n, requestedAt: START - 21 * DAY, nextSyncAt: START - 1_000 });
  }
  await w.db.insert("pullRequests", { caseId: await aCase(w, "apps:1"), source: "attached", repo: "alice/shop", number: 7, requestedAt: START, nextSyncAt: START });
  await followPullRequests(t, w, START, START + MINUTE);
  const alice = reached.find((read) => read.repo === "alice/shop");
  assert.ok(alice && alice.at - START < MINUTE, "Alice's pull request was read within a minute");
  // Mallory's, open for three weeks, are each read once and then not again for an hour; Alice's every 30 seconds.
  await followPullRequests(t, w, START + MINUTE, START + 59 * MINUTE);
  assert.equal(reached.filter((read) => read.repo === "mallory/forever").length, 1000);
  assert.ok(reached.filter((read) => read.repo === "alice/shop").length >= 20);
  // The whole set is never read: the cron reads due rows through the index, a batch at a time.
  assert.equal(w.load("convex/prTracking/records.ts").active, undefined);
});

test("a pull request from before next-sync times were kept is read at once, and so is a new one beside 1,000 such", async (t) => {
  const { w, reached } = following(t);
  const caseId = await aCase(w, "apps:0");
  for (let n = 1; n <= 1000; n++) await w.db.insert("pullRequests", { caseId, source: "attached", repo: "mallory/old", number: n, requestedAt: START - 21 * DAY });
  await w.db.insert("pullRequests", { caseId, source: "attached", repo: "alice/new", number: 1, requestedAt: START, nextSyncAt: START });
  await followPullRequests(t, w, START, START + 30_000);
  assert.deepEqual(reached.filter((read) => read.repo === "alice/new").map((read) => read.at), [START], "the new one at the first tick");
  assert.equal(reached.filter((read) => read.repo === "mallory/old").length, 1000, "and every old one too");
});

test("a pull request left open is read less and less often: every 30 seconds, then 2 and 10 minutes, then once an hour", async (t) => {
  const { w, reached } = following(t);
  await w.db.insert("pullRequests", { caseId: await aCase(w, "apps:0"), source: "attached", repo: "ada/slow", number: 1, requestedAt: START });
  await followPullRequests(t, w, START, START + 2 * DAY);
  const times = reached.map((read) => read.at - START);
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  const within = (from, to) => gaps.filter((_, i) => times[i] >= from && times[i] < to);
  assert.ok(within(0, 9 * MINUTE).every((gap) => gap === 30_000), "the first ten minutes: every tick");
  assert.ok(within(11 * MINUTE, 59 * MINUTE).every((gap) => gap === 2 * MINUTE), JSON.stringify(within(11 * MINUTE, 59 * MINUTE)));
  assert.ok(within(61 * MINUTE, 23 * 60 * MINUTE).every((gap) => gap === 10 * MINUTE));
  assert.ok(within(DAY + MINUTE, 2 * DAY).every((gap) => gap === 60 * MINUTE), "after a day, the floor: once an hour");
  assert.equal(times.filter((time) => time >= DAY).length, 24);
});

test("in the single-owner demo every open pull request is still read at every tick", async (t) => {
  const { w, reached } = following(t, {});
  await w.db.insert("pullRequests", { caseId: await aCase(w, "apps:0"), source: "attached", repo: "demo/booking", number: 1, requestedAt: START - 21 * DAY });
  await followPullRequests(t, w, START, START + 10 * MINUTE);
  assert.equal(reached.length, 20);
});

test("ATTACK (finding 15): 1,000 older open preparations and 500 never approved no longer leave a new one unread", async (t) => {
  const { w, reached } = following(t);
  const mallory = await w.db.insert("users", { email: "mallory@example.com" });
  const project = (owner, name) => w.db.insert("apps", { name, ownerId: owner, repoUrl: `https://github.com/${name}` });
  // Rows from before next-sync times were kept: 1,000 approved and still open, 500 never approved.
  for (let n = 0; n < 1000; n++) {
    await w.db.insert("onboardingPreparations", { appId: await project(mallory, `m${n}`), neverBreak: [], approvedAt: START - 7 * DAY, requestedAt: START - 7 * DAY, repo: "mallory/forever", number: n + 1, capyThreadId: "t" });
  }
  for (let n = 0; n < 500; n++) await w.db.insert("onboardingPreparations", { appId: await project(mallory, `u${n}`), neverBreak: [] });
  // Alice approves hers now (onboarding/projects:approve sets its first next-sync time).
  const alice = await w.db.insert("users", { email: "alice@example.com" });
  const id = await w.db.insert("onboardingPreparations", { appId: await project(alice, "alice/shop"), neverBreak: [], approvedAt: START, requestedAt: START, nextSyncAt: START, repo: "alice/shop", number: 3, capyThreadId: "t" });
  const tick = async (now) => {
    t.mock.timers.setTime(now);
    await w.run("internal.onboarding.prepare.refreshActive", {});
    await w.drain(["internal.onboarding.prepare.syncDue"]);
  };
  await tick(START);
  assert.deepEqual(reached.filter((read) => read.repo === "alice/shop").map((read) => read.at), [START], "Alice's is read at the first tick");
  await tick(START + MINUTE);
  assert.equal(reached.filter((read) => read.repo === "mallory/forever").length, 1000, "every older one was read too, not only the 100 oldest");
  const rows = w.rows("onboardingPreparations");
  assert.equal(rows.filter((row) => row.approvedAt === undefined && row.nextSyncAt === Number.MAX_SAFE_INTEGER).length, 500, "the ones never approved are not followed");
  assert.ok(rows.find((row) => row._id === id).nextSyncAt > START);
});

// ---- Statement 8: what triage reads on one project ----

/** Documents one call reads, as Convex counts them against that function. */
async function documentsRead(w, path, args, caller = null) {
  w.reads.length = 0;
  const result = await w.run(path, args, caller);
  return { result, documents: w.reads.reduce((sum, [, , documents]) => sum + documents, 0) };
}

test("ATTACK: a project's customers pile 20,000 reports onto one case and 3,000 cases onto the project; triage still reads a bounded amount", async (t) => {
  const w = world(t);
  network(t, {});
  const alice = await w.db.insert("users", { email: "alice@example.com" });
  const appId = await w.db.insert("apps", { name: "shop", ownerId: alice, productionUrl: "https://shop.example" });
  await w.db.insert("intakeKeys", { appId, key: "tik_shop", createdAt: 1 });
  for (let n = 0; n < 3000; n++) await w.db.insert("cases", { appId, title: `old ${n}`, impact: ".", kind: "bug_report", raisedBy: "customer", status: "resolved" });
  const caseId = await w.db.insert("cases", { appId, title: "Booking fails", impact: ".", kind: "bug_report", raisedBy: "customer", status: "waiting_for_owner", reportCount: 20_000, distinctRequesterCount: 5_000 });
  for (let n = 0; n < 20_000; n++) {
    const reportId = await w.db.insert("reports", { appId, caseId, channel: "form", fromRef: `form:device:${n % 5000}`, text: `Booking fails again (${n}).`, provider: "turtl-form", providerEventId: `e${n}`, receivedAt: START - 20_000 + n });
    await w.db.insert("reportTriage", { reportId, appId, fingerprint: `fp-${n}`, status: "done", verdict: "bug", outcome: "attached", caseId });
  }
  // Before, triage read every case on the project and every report and triage row on each open customer case: past
  // Convex's limit on what one function may read, so every report on the project failed triage.
  assert.deepEqual(await w.run("internal.intake.records.receive", { key: "tik_shop", text: "Booking fails again (new).", reporterId: "device-9999", reportId: "new" }), { ok: true, duplicate: false });
  const triageId = w.rows("reportTriage").find((row) => row.status === "pending")._id;
  const input = await documentsRead(w, "internal.intake.records.triageInput", { triageId });
  assert.deepEqual(input.result.candidates.map((candidate) => candidate.caseId), [caseId], "the open case is still offered");
  assert.ok(input.documents < 1_000, `triage read ${input.documents} documents`);
  const landed = await documentsRead(w, "internal.intake.records.land", { triageId, verdict: "bug", source: "rules", reason: "The same as the open case.", attachTo: caseId });
  assert.deepEqual(landed.result, { outcome: "attached", caseId });
  assert.ok(landed.documents < 1_000, `landing read ${landed.documents} documents`);
  const row = w.rows("cases").find((c) => c._id === caseId);
  assert.deepEqual([row.reportCount, row.distinctRequesterCount], [20_001, 5_001], "the counts are kept as reports join");
  // The owner's screens list the newest, with the counts kept on the case.
  const forCase = await documentsRead(w, "api.intake.records.forCase", { caseId }, alice);
  assert.equal(forCase.result.reports.length, 200);
  assert.equal(forCase.result.people, 5_001);
  assert.equal(forCase.result.reports[0].text, "Booking fails again (new).");
  assert.ok(forCase.documents < 1_000);
  const forApp = await documentsRead(w, "api.intake.records.forApp", { appId }, alice);
  assert.equal(forApp.result.length, 200);
  assert.ok(forApp.documents < 1_000);
  // A report from someone already on the case adds a report, not a person.
  await w.run("internal.intake.records.receive", { key: "tik_shop", text: "Still failing.", reporterId: "9", reportId: "again" });
  const again = w.rows("reportTriage").find((row) => row.status === "pending")._id;
  await w.run("internal.intake.records.land", { triageId: again, verdict: "bug", source: "rules", reason: ".", attachTo: caseId });
  const after = w.rows("cases").find((c) => c._id === caseId);
  assert.deepEqual([after.reportCount, after.distinctRequesterCount], [20_002, 5_001]);
});

// ---- Statement 3, end to end: with the day's AI used up, turtl still opens the case ----

test("with every account's AI used up for the day, a failing check still opens a case, and so does a customer's report", async (t) => {
  const w = world(t, { ...ACCOUNTS, OPENAI_API_KEY: "sk-test-stand-in" });
  const sent = network(t, { "shop.example": () => json(failed) });
  const services = w.load("convex/consent/services.ts");
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  await w.db.insert("aiConsents", { account: ada, answer: "allowed", services: services.ASKED.map(({ id, version }) => ({ id, version })), listVersion: services.LIST_VERSION, answeredAt: 1 });
  await w.db.insert("deploymentTotals", { name: "model_usd_day", window: "2026-11-16", value: 25, updatedAt: 1 });
  const appId = await project(w, ada, "shop.example");
  await w.run("internal.monitor.tick", {});
  await w.drain(["internal.monitor.checkProject"]);
  assert.deepEqual(w.rows("cases").map((row) => [row.raisedBy, row.kind]), [["monitor", "outage"]], "the monitor opened the case");
  // A customer's report: triage asks the gate, is refused, and judges the report by its rules.
  await w.db.insert("intakeKeys", { appId, key: "tik_ada", createdAt: 1 });
  await w.run("internal.intake.records.receive", { key: "tik_ada", text: "The booking page shows an error and I cannot pay for my appointment.", reportId: "r1" });
  await w.drain(["internal.intake.triage.processNext"]);
  const triage = w.rows("reportTriage")[0];
  assert.equal(triage.outcome, "opened");
  assert.match(triage.reason, /no model answered \(turtl has reached the most AI it uses in one day across everyone, so no model was asked; it starts again tomorrow\)/i);
  assert.deepEqual(w.rows("cases").map((row) => row.raisedBy), ["monitor", "customer"]);
  assert.deepEqual(sent.filter((request) => request.host === "api.openai.com"), [], "no model was asked");
});

// ---- Follow-up: settling agent run outcomes (convex/routing/log.ts) ----

const agentRun = (fields) => ({
  taskType: "diagnose_outage",
  config: { modelId: "gpt-6.1-sol", harnessVersion: "h", promptVersion: "p" },
  taskCharacteristics: { complexity: "c", risk: "r", framework: "f", repositoryArea: "a" },
  contextRefs: [],
  routingReason: ".",
  status: "completed",
  corrections: [],
  ...fields,
});

/** One tick of the settling cron, with the runs it starts again at once while a look comes back full. */
async function settleTick(t, w, now) {
  t.mock.timers.setTime(now);
  await w.run("internal.routing.log.settlePending", {});
  await w.drain(["internal.routing.log.settlePending"]);
}

test("ATTACK (finding 15): 1,000 of another account's runs that never settle, and 500 that never could, no longer keep Alice's run from being settled", async (t) => {
  const w = world(t);
  network(t, {});
  // Before, the cron took the 200 oldest unsettled runs. Repository readings at onboarding have no case, so they never
  // settle: 500 of them, oldest of all, and nothing newer was ever settled again.
  for (let n = 0; n < 500; n++) await w.db.insert("agentRuns", agentRun({ appId: "apps:m", taskType: "onboarding_inspection" }));
  // Mallory's 1,000 diagnoses on cases she leaves open, all due now.
  const mallorys = [];
  for (let n = 0; n < 1000; n++) {
    const caseId = await w.db.insert("cases", { appId: "apps:m", title: `m${n}`, impact: ".", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" });
    const id = await w.db.insert("agentRuns", agentRun({ caseId, nextSettleAt: START - 1_000 }));
    await w.db.patch(id, { _creationTime: START - 2 * DAY });
    mallorys.push(id);
  }
  // Alice's diagnosis was verified by the fix it led to.
  const alicesCase = await w.db.insert("cases", { appId: "apps:a", title: "a", impact: ".", kind: "outage", raisedBy: "monitor", status: "restored" });
  await w.db.insert("verifications", { caseId: alicesCase, stepAttemptId: "stepAttempts:1", phase: "after_fix", environment: "test", revision: {}, checkVersion: "v1", criteriaVersion: "v1", criterionResults: [], evidenceIds: [], startedAt: START, completedAt: START, verdict: "passed", summary: "A test booking was saved." });
  const alicesRun = await w.db.insert("agentRuns", agentRun({ caseId: alicesCase, nextSettleAt: START }));

  await settleTick(t, w, START + 2 * MINUTE);
  const runs = new Map(w.rows("agentRuns").map((row) => [row._id, row]));
  assert.equal(runs.get(alicesRun).outcome, "verified", "Alice's run was settled at the next tick");
  assert.equal(w.rows("agentRuns").filter((row) => row.taskType === "onboarding_inspection" && row.outcomeReason === "Not scored: only diagnosis runs are scored for routing.").length, 500, "runs that are never scored are settled at once");
  assert.ok(mallorys.every((id) => runs.get(id).outcomeAt === undefined && runs.get(id).nextSettleAt > START + 55 * MINUTE), "Mallory's, two days old, are next looked at in an hour");
  // Each look reads a bounded amount: 200 runs at most, and each case's newest 50 verifications.
  assert.ok(w.reads.filter(([table]) => table === "agentRuns").every(([, , documents]) => documents <= 100));

  // Thirty days after they were made, the cron stops following them: they are settled as never finished.
  await settleTick(t, w, START + 28 * DAY + MINUTE);
  assert.ok(
    w.rows("agentRuns").filter((row) => mallorys.includes(row._id)).every((row) => row.outcomeAt !== undefined && /had not finished 30 days after/.test(row.outcomeReason)),
  );
  assert.equal(w.rows("agentRuns").filter((row) => row.outcomeAt === undefined).length, 0);
});

test("a diagnosis run waiting on its case is looked at every tick for an hour, every 10 minutes for a day, then once an hour", async (t) => {
  const w = world(t);
  const log = w.load("convex/routing/log.ts");
  const made = START;
  assert.equal(log.nextSettleAt(made, made + 30 * MINUTE) - (made + 30 * MINUTE), 2 * MINUTE - 10_000);
  assert.equal(log.nextSettleAt(made, made + 2 * 60 * MINUTE) - (made + 2 * 60 * MINUTE), 10 * MINUTE - 10_000);
  assert.equal(log.nextSettleAt(made, made + 3 * DAY) - (made + 3 * DAY), 60 * MINUTE - 10_000);
  assert.equal(log.NEVER_FINISHED_MS, 30 * DAY);
});

// ---- Follow-up: what the structural step reads on a project that has grown ----

test("ATTACK: 2,000 earlier cases on a project and thousands of evidence rows on the cases it relates; the structural step reads a bounded amount", async (t) => {
  const w = world(t);
  network(t, {});
  const appId = await w.db.insert("apps", { name: "shop", ownerId: "users:1", productionUrl: "https://shop.example" });
  const signature = "journey_failed:journeys:1";
  // Each failure the monitor saw opened a case with the same signature, and each case gathered a lot of evidence.
  const caseOf = async (n) => w.db.insert("cases", { appId, title: `Booking failed ${n}`, impact: ".", kind: "outage", raisedBy: "monitor", status: "unresolved", signature });
  for (let n = 0; n < 1990; n++) await caseOf(n);
  for (let n = 1990; n < 2000; n++) {
    const caseId = await caseOf(n);
    for (let e = 0; e < 300; e++) await w.db.insert("evidence", { caseId, kind: "memory_match", title: `match ${e}`, sourceRef: "m", observedAt: e });
  }
  const caseId = await caseOf(2000);
  for (let e = 0; e < 1000; e++) await w.db.insert("evidence", { caseId, kind: e < 900 ? "memory_match" : "health", title: `row ${e}`, sourceRef: "s", observedAt: e });

  const read = await documentsRead(w, "internal.structural.records.examineContext", { caseId });
  assert.equal(read.result.skip, null, "the case is still examined");
  assert.equal(read.result.relatedCaseIds.length, 50, "against the 50 cases before it");
  // Before, it read all 2,000 cases and every one of the 4,000 evidence rows on the cases it relates.
  assert.ok(read.documents < 3_000, `the structural step read ${read.documents} documents`);
  assert.ok(w.reads.filter(([table]) => table === "cases").every(([, , documents]) => documents <= 200));
  assert.ok(w.reads.filter(([table]) => table === "evidence").every(([, , documents]) => documents <= 100));
  // What is lost past the bounds: the current case's first 100 rows are all memory matches, so it offers no evidence
  // beyond them (its health rows come later). That is the cost the code names (EVIDENCE_READ).
  assert.deepEqual(read.result.prompt.current.evidence, []);
});

// ---- Finding 19: a case records how long its check had been passing, for the outage reserve ----

test("a case the monitor opens records how long its check had been passing; a failure or no answer starts the count again", async (t) => {
  const w = world(t);
  let answer = () => json(passed);
  const sent = network(t, { "shop.example": (...args) => answer(...args) });
  const ada = await w.db.insert("users", { email: "ada@example.com" });
  const appId = await project(w, ada, "shop.example");
  // A day and an hour of passing checks, then a failure.
  await minutesAsked(t, w, sent, "shop.example", 0, 25 * 60);
  answer = () => json(failed);
  await minutesAsked(t, w, sent, "shop.example", 25 * 60, 25 * 60 + 1);
  const first = w.rows("cases").at(-1);
  assert.ok(first.passingForMs >= 24 * 60 * MINUTE && first.passingForMs <= 25 * 60 * MINUTE, String(first.passingForMs));
  // The owner closes it; the app passes for an hour, then fails again: that case had passed for only an hour.
  // (This harness stamps rows with a fixed creation time; the case was opened at the 25th hour.)
  await w.db.patch(first._id, { status: "resolved", _creationTime: START + 25 * 60 * MINUTE });
  answer = () => json(passed);
  await minutesAsked(t, w, sent, "shop.example", 25 * 60 + 20, 26 * 60 + 20);
  // No answer at all in between also ends the run of passes.
  answer = () => new Response("down", { status: 502 });
  await minutesAsked(t, w, sent, "shop.example", 26 * 60 + 20, 26 * 60 + 21);
  answer = () => json(passed);
  await minutesAsked(t, w, sent, "shop.example", 26 * 60 + 21, 26 * 60 + 31);
  answer = () => json(failed);
  await minutesAsked(t, w, sent, "shop.example", 26 * 60 + 31, 26 * 60 + 32);
  const second = w.rows("cases").at(-1);
  assert.notEqual(second._id, first._id);
  assert.ok(second.passingForMs <= 11 * MINUTE, `counted from after the check that got no answer: ${second.passingForMs}`);
  assert.equal(w.rows("journeys").find((row) => row.appId === appId).passingSince, undefined, "the failure ended the run");
});

// ---- Statement 9: the live address's port ----

test("ATTACK: an account cannot point its live app at another port of someone else's host, so turtl probes no port but the web's", async (t) => {
  const w = world(t);
  const sent = network(t, {});
  const mallory = await w.db.insert("users", { email: "mallory@example.com" });
  for (const liveUrl of ["https://victim.example:22", "https://victim.example:6379", "https://victim.example:8443/app"]) {
    await assert.rejects(
      w.run("api.onboarding.projects.add", { repoUrl: "https://github.com/mallory/app", liveUrl }, mallory),
      (error) => error.data === "The live app address must be the one your customers use, with no port number, like https://app.example.com.",
      liveUrl,
    );
  }
  // https's own port, written or not, is the same address.
  const added = await w.run("api.onboarding.projects.add", { repoUrl: "https://github.com/mallory/app", liveUrl: "https://victim.example:443" }, mallory);
  assert.equal((await w.db.get(added.projectId)).productionUrl, "https://victim.example");
  // A row from before the rule, aimed at a port, is not checked, and its owner reads why; nothing is sent.
  const old = await project(w, mallory, "victim.example");
  await w.db.patch(old, { productionUrl: "https://victim.example:22" });
  const swept = await w.run("internal.monitor.tick", {});
  assert.deepEqual(swept.skipped.find((skip) => skip.appId === old)?.reason, "The live app address must be the one your customers use, with no port number, like https://app.example.com.");
  await w.drain(["internal.monitor.checkProject"]);
  assert.deepEqual(sent.filter((request) => request.host.includes(":")), []);
  // The single-owner demo applies none of this, and a local backend's stand-ins on 127.0.0.1 keep their ports.
  const address = w.load("convex/protectedApp/address.ts");
  assert.equal(address.liveAddressProblem("http://127.0.0.1:3321/booking-demo", true), null);
});
