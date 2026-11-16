import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createLoader, memoryDb, root, withEnv } from "./fixtures/convex-memory.mjs";

// The practice project (convex/practice), without a server: its rules, two accounts each with their own practice app
// (breaking, fixing and limits change nothing of the other's, nor the single-owner demo's booking app), the practice
// routes answering only to their own project's token, the known switches, and the screens that must not offer what a
// practice app has not got. scripts/practice/prove-local.mjs proves the whole flow on a real local backend.

const SITE = "https://happy-otter-123.convex.site";
const ACCOUNTS = { AUTH_REQUIRED: "true", CONVEX_SITE_URL: SITE, CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud", PRACTICE_BREAKS_PER_DAY: undefined, WATCHED_APP_ALLOW_LOOPBACK: undefined };
const hash = (token) => createHash("sha256").update(token).digest("hex");
const TOKENS = { alice: "alice-practice-token-" + "a".repeat(40), bob: "bob-practice-token-" + "b".repeat(40) };

// The schema reaches Convex Auth's tables, which ship only as an ES module.
const esModules = { "@convex-dev/auth/server": await import("@convex-dev/auth/server") };

function world() {
  const load = createLoader(esModules);
  const tables = load("convex/schema.ts").default.tables;
  const db = memoryDb(tables, {
    users: [{ _id: "users:alice", email: "alice@example.com" }, { _id: "users:bob", email: "bob@example.com" }],
    bookingDemoSettings: [{ _id: "bookingDemoSettings:1", key: "demo", recommendationsEnabled: true, providerTimeout: false, bookingStoreFailure: false, updatedAt: 1 }],
  });
  const scheduled = [];
  const scheduler = { runAfter: async (delay, fn, args) => (scheduled.push({ path: fn.path, args }), `_scheduled_functions:${scheduled.length}`) };
  const as = (who) => ({ db, scheduler, auth: { getUserIdentity: async () => (who ? { subject: `users:${who}|proof-session` } : null) } });
  const fn = (path) => {
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const definition = load(`convex/${segments.join("/")}.ts`)[name];
    assert.ok(definition?.handler, "No function " + path);
    return definition;
  };
  // An action's ctx: queries and mutations run against the same database, as the scheduler's account-less jobs do.
  const actionCtx = { runQuery: (ref, args) => fn(ref.path).handler(as(null), args), runMutation: (ref, args) => fn(ref.path).handler(as(null), args), runAction: (ref, args) => fn(ref.path).handler(actionCtx, args) };
  return { load, db, scheduled, as, fn, actionCtx };
}

async function twoPracticeProjects(w) {
  const { claim } = w.load("convex/practice/projects.ts");
  const made = {};
  for (const who of ["alice", "bob"]) {
    const { appId, seal } = await claim.handler(w.as(null), { account: `users:${who}`, tokenHash: hash(TOKENS[who]) });
    assert.equal(seal, true);
    // The token itself is sealed in convex/secrets by the action (managed.ts); here a stand-in row says it is there.
    await w.db.insert("secrets", { kind: "control_token", account: `users:${who}`, appId, sealed: "v1.sealed", keyId: "key", setAt: 1 });
    made[who] = appId;
  }
  return made;
}

const practiceRow = async (w, appId) => (await w.db.query("practiceApps").withIndex("by_app", (q) => q.eq("appId", appId)).first());
const message = (error) => String(error?.data ?? error?.message ?? error);

// ------------------------------------------------------------------------------------------------- the rules

test("the practice app's failures, what is broken now, and what an earlier fix left switched", () => {
  const rules = createLoader()("convex/practice/rules.ts");
  assert.equal(rules.failureOf(rules.WORKING), null);
  assert.equal(rules.failureOf(rules.BREAKS.recommendations), "recommendations");
  assert.equal(rules.failureOf(rules.BREAKS.booking_store), "booking_store");
  assert.equal(rules.failureOf({ ...rules.BREAKS.recommendations, recommendationsEnabled: false }), null, "turning recommendations off recovers");
  assert.equal(rules.failureOf({ ...rules.BREAKS.booking_store, backupStoreEnabled: true }), null, "the backup store recovers");
  assert.equal(rules.noteOf({ ...rules.BREAKS.recommendations, recommendationsEnabled: false }), "Recommendations are off since turtl's last fix.");
  assert.equal(rules.noteOf({ ...rules.BREAKS.booking_store, backupStoreEnabled: true }), "Bookings go to the backup store since turtl's last fix.");
  assert.equal(rules.noteOf(rules.WORKING), null);
  // Each break leaves the whole state, so it fails whatever an earlier fix switched.
  for (const failure of rules.FAILURES) assert.equal(rules.failureOf(rules.BREAKS[failure]), failure);
  assert.deepEqual(rules.routeOf("/practice/apps:1/flags"), { appId: "apps:1", endpoint: "flags" });
  for (const path of ["/practice/", "/practice/apps:1", "/practice/apps:1/flags/x", "/booking-demo/flags", "/practice//flags"]) assert.equal(rules.routeOf(path), null, path);
  assert.equal(rules.practiceBase(SITE + "/", "apps:1"), SITE + "/practice/apps:1");
  assert.equal(rules.practiceBreaksPerDay(undefined), 10);
  assert.equal(rules.practiceBreaksPerDay("3"), 3);
  for (const bad of ["", "0", "-2", "many"]) assert.equal(rules.practiceBreaksPerDay(bad), 10, bad);
  const day = Date.UTC(2026, 10, 16, 12);
  assert.deepEqual(rules.allowance({ day: "2026-11-16", count: 3 }, day, 10), { day: "2026-11-16", used: 3, left: 7 });
  assert.deepEqual(rules.allowance({ day: "2026-11-15", count: 10 }, day, 10), { day: "2026-11-16", used: 0, left: 10 }, "a new UTC day starts again");
});

// ------------------------------------------------------------------------------------------------- two accounts

test("two accounts: each has its own practice project, and breaking one changes nothing of the other's or the demo's", async () => {
  await withEnv(ACCOUNTS, async () => {
    const w = world();
    const { status, breakApp, mend, claim } = w.load("convex/practice/projects.ts");
    const { alice, bob } = await twoPracticeProjects(w);
    assert.notEqual(alice, bob);
    // Asking again returns the same project.
    assert.deepEqual(await claim.handler(w.as(null), { account: "users:alice", tokenHash: hash("another") }), { appId: alice, seal: false });
    assert.equal((await practiceRow(w, alice)).tokenHash, hash(TOKENS.alice), "a second Create never replaces the token");

    for (const [who, appId] of [["alice", alice], ["bob", bob]]) {
      const app = await w.db.get(appId);
      assert.deepEqual({ name: app.name, practice: app.practice, repoUrl: app.repoUrl, productionUrl: app.productionUrl }, { name: "Practice booking app", practice: true, repoUrl: undefined, productionUrl: `${SITE}/practice/${appId}` });
      const catalog = await w.db.query("actionCatalog").withIndex("by_app_and_type", (q) => q.eq("appId", appId)).take(10);
      assert.deepEqual(catalog.map((entry) => [entry.name, entry.config.kind, entry.config.url]), [
        ["Turn off recommendations", "http", `${SITE}/practice/${appId}/flags`],
        ["Save bookings to the backup store", "http", `${SITE}/practice/${appId}/backup-store`],
      ], "two switches and no pull request action: a practice app has no repository");
      const shown = await status.handler(w.as(who), {});
      assert.equal(shown.project.projectId, appId);
      assert.equal(shown.project.failure, null);
    }
    assert.equal(w.db.rows("onboardingPreparations").length, 0, "nothing reads a repository for a practice project");
    assert.equal(w.db.rows("codeNetworks").length, 0);

    const bobBefore = await practiceRow(w, bob);
    const demoBefore = w.db.rows("bookingDemoSettings");
    const result = await breakApp.handler(w.as("alice"), { projectId: alice, failure: "recommendations" });
    assert.deepEqual(result, { breaksLeft: 9 });
    const aliceAfter = await practiceRow(w, alice);
    assert.deepEqual([aliceAfter.recommendationsEnabled, aliceAfter.providerTimeout, aliceAfter.broken.failure, aliceAfter.breaks.count], [true, true, "recommendations", 1]);
    assert.deepEqual(await practiceRow(w, bob), bobBefore, "Bob's practice app is untouched");
    assert.deepEqual(w.db.rows("bookingDemoSettings"), demoBefore, "the demo's booking app is untouched");
    assert.deepEqual(w.scheduled, [{ path: "internal.monitor.checkProject", args: { appId: alice } }], "Alice's project gets its monitor turn at once, and only hers");

    assert.equal((await status.handler(w.as("alice"), {})).project.failure, "recommendations");
    assert.equal((await status.handler(w.as("bob"), {})).project.failure, null);

    // Bob cannot break, or put back, Alice's practice app: her project reads as one that does not exist.
    for (const call of [() => breakApp.handler(w.as("bob"), { projectId: alice, failure: "booking_store" }), () => mend.handler(w.as("bob"), { projectId: alice })]) {
      await assert.rejects(call(), (error) => message(error) === "That project is not available on this account.");
    }
    await assert.rejects(breakApp.handler(w.as(null), { projectId: bob, failure: "booking_store" }), (error) => message(error) === "Sign in to continue.");
    assert.equal((await practiceRow(w, alice)).bookingStoreFailure, false);
  });
});

test("a practice app breaks only while it works with no open case, and at most so many times a day", async () => {
  await withEnv({ ...ACCOUNTS, PRACTICE_BREAKS_PER_DAY: "2" }, async () => {
    const w = world();
    const { breakApp, mend, status } = w.load("convex/practice/projects.ts");
    const { alice, bob } = await twoPracticeProjects(w);
    await breakApp.handler(w.as("alice"), { projectId: alice, failure: "booking_store" });
    await assert.rejects(breakApp.handler(w.as("alice"), { projectId: alice, failure: "recommendations" }), (error) => /already broken/.test(message(error)));
    // An open case on it: no break and no put-back until it is decided.
    const caseId = await w.db.insert("cases", { appId: alice, title: "Booking is failing", impact: "", kind: "outage", raisedBy: "monitor", status: "waiting_for_owner" });
    assert.equal((await status.handler(w.as("alice"), {})).project.caseId, caseId);
    await assert.rejects(mend.handler(w.as("alice"), { projectId: alice }), (error) => /Decline its fixes under Fix first/.test(message(error)));
    await w.db.patch(caseId, { status: "declined" });
    await mend.handler(w.as("alice"), { projectId: alice });
    assert.equal((await status.handler(w.as("alice"), {})).project.failure, null);
    await breakApp.handler(w.as("alice"), { projectId: alice, failure: "recommendations" });
    await mend.handler(w.as("alice"), { projectId: alice });
    await assert.rejects(breakApp.handler(w.as("alice"), { projectId: alice, failure: "recommendations" }), (error) => message(error) === "You have broken your practice app 2 times today, the most for one day. You can break it again tomorrow.");
    assert.equal((await status.handler(w.as("alice"), {})).project.breaksLeft, 0);
    assert.equal((await status.handler(w.as("bob"), {})).project.breaksLeft, 2, "each account has its own allowance");
    await breakApp.handler(w.as("bob"), { projectId: bob, failure: "booking_store" });
    // The operator's setup of the review account does not count.
    const { operatorBreak, operatorMend } = w.load("convex/practice/projects.ts");
    await operatorMend.handler(w.as(null), { appId: alice });
    await operatorBreak.handler(w.as(null), { appId: alice, failure: "recommendations" });
    assert.equal((await practiceRow(w, alice)).breaks.count, 2);
    // A project that is not a practice app has none of this.
    const other = await w.db.insert("apps", { name: "shop", ownerId: "users:alice", productionUrl: "https://shop.example.com" });
    await assert.rejects(breakApp.handler(w.as("alice"), { projectId: other, failure: "recommendations" }), (error) => message(error) === "That project is not a practice app.");
  });
});

test("with AUTH_REQUIRED unset (the single-owner demo) there is no practice app to offer or make", async () => {
  await withEnv({ ...ACCOUNTS, AUTH_REQUIRED: undefined }, async () => {
    const w = world();
    const { status, claim, practiceProblem } = w.load("convex/practice/projects.ts");
    assert.deepEqual(await status.handler(w.as(null), {}), { available: false, breaksPerDay: 10, project: null });
    assert.equal(practiceProblem(), "A practice app needs accounts, and this backend runs the single-owner demo.");
    await assert.rejects(claim.handler(w.as(null), { account: "solo-owner", tokenHash: hash("x") }), /needs accounts/);
    assert.equal(w.db.rows("apps").length, 0);
  });
  // A backend whose own address turtl may not watch cannot run one either.
  await withEnv({ ...ACCOUNTS, CONVEX_SITE_URL: "http://127.0.0.1:3271" }, async () => {
    const w = world();
    assert.equal(w.load("convex/practice/projects.ts").practiceProblem(), "turtl can't run a practice app on this backend, because its own web address can't be watched.");
    assert.equal((await w.load("convex/practice/projects.ts").status.handler(w.as("alice"), {})).available, false);
  });
});

// ------------------------------------------------------------------------------------------------- the routes

function routes(w) {
  const handlers = {};
  w.load("convex/practice/http.ts").registerPracticeRoutes({ route: ({ pathPrefix, method, handler }) => (handlers[method] = { pathPrefix, handler }) });
  assert.deepEqual(Object.values(handlers).map((h) => h.pathPrefix), ["/practice/", "/practice/"]);
  return async (method, path, { token, body } = {}) => {
    const request = new Request(SITE + path, { method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { "Content-Type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const response = await handlers[method].handler(w.actionCtx, request);
    return { status: response.status, body: await response.json() };
  };
}

test("each practice app's routes answer only to its own project's token, and change only its own rows", async () => {
  await withEnv(ACCOUNTS, async () => {
    const w = world();
    const { alice, bob } = await twoPracticeProjects(w);
    const send = routes(w);
    assert.equal((await send("GET", `/practice/${alice}/health`)).status, 200);
    assert.equal((await send("GET", `/practice/${alice}/revision`)).body.revision, "practice-booking-v1");
    assert.equal((await send("GET", "/practice/apps:404/health")).status, 404);
    assert.equal((await send("GET", `/practice/${alice}/flags`)).status, 401);
    assert.equal((await send("GET", `/practice/${alice}/flags`, { token: TOKENS.bob })).status, 401, "Bob's token does not open Alice's app");
    assert.equal((await send("POST", `/practice/${bob}/journey-check`, { token: TOKENS.alice })).status, 401);
    assert.equal((await send("POST", `/practice/${alice}/staged-failure`, { token: TOKENS.alice, body: { providerTimeout: true } })).status, 404, "no route breaks a practice app");
    assert.deepEqual((await send("GET", `/practice/${alice}/errors`, { token: TOKENS.alice })).body.counts, { totalBookings: 0, failedBookings: 0, successfulBookings: 0, errorRate: 0 });

    const passing = await send("POST", `/practice/${alice}/journey-check`, { token: TOKENS.alice });
    assert.equal(passing.status, 200);
    assert.equal(passing.body.verdict, "passed");
    assert.equal(w.db.rows("practiceBookings").length, 0, "the test booking is deleted");

    // The catalog's switch, as authorize_and_execute sends it.
    const bobBefore = await practiceRow(w, bob);
    assert.equal((await send("POST", `/practice/${alice}/flags`, { token: TOKENS.alice, body: { recommendationsEnabled: "false" } })).status, 400);
    assert.equal((await send("POST", `/practice/${alice}/flags`, { token: TOKENS.alice, body: { backupStoreEnabled: true } })).status, 400, "each path sets only its own switch");
    const set = await send("POST", `/practice/${alice}/flags`, { token: TOKENS.alice, body: { recommendationsEnabled: false } });
    assert.equal(set.body.recommendationsEnabled, false);
    assert.equal((await practiceRow(w, alice)).recommendationsEnabled, false);
    assert.deepEqual(await practiceRow(w, bob), bobBefore);

    // Bob's app with its booking store down: the journey fails at the last step, and the backup store recovers it.
    await w.load("convex/practice/projects.ts").breakApp.handler(w.as("bob"), { projectId: bob, failure: "booking_store" });
    const failing = await send("POST", `/practice/${bob}/journey-check`, { token: TOKENS.bob });
    assert.equal(failing.status, 503);
    assert.deepEqual([failing.body.failedStep, failing.body.error.code], ["submit_booking", "BOOKING_STORE_UNAVAILABLE"]);
    assert.equal((await send("GET", `/practice/${bob}/backup-store`, { token: TOKENS.bob })).body.backupStoreEnabled, false);
    await send("POST", `/practice/${bob}/backup-store`, { token: TOKENS.bob, body: { backupStoreEnabled: true } });
    const recovered = await send("POST", `/practice/${bob}/journey-check`, { token: TOKENS.bob });
    assert.equal(recovered.status, 200);
    assert.match(recovered.body.steps.find((s) => s.step === "submit_booking").detail, /backup store/);
    assert.equal((await practiceRow(w, alice)).bookingStoreFailure, false, "nothing of Bob's reached Alice's app");
    // The prevention check's scenario, as the booking demo runs it.
    const scenario = await send("POST", `/practice/${bob}/journey-check?scenario=slow_recommendations`, { token: TOKENS.bob });
    assert.equal(scenario.body.scenario, "slow_recommendations");
    assert.equal((await send("POST", `/practice/${bob}/journey-check?scenario=nope`, { token: TOKENS.bob })).status, 400);
  });
});

// ------------------------------------------------------------------------------------------------- the machinery

test("plan and verify know both switches, and the recommendations switch keeps the words the demo always used", () => {
  const { SWITCHES, switchOf, switchNamed } = createLoader()("convex/protectedApp/switches.ts");
  const flagEntry = (flag, kind = "http") => ({ type: "set_feature_flag", config: kind === "http" ? { kind, url: "u", method: "POST" } : { kind, repoUrl: "r", baseBranch: "main" }, parameterConstraints: [{ name: "flag", type: "string", required: true, allowedValues: [flag] }] });
  assert.equal(switchOf(flagEntry("recommendationsEnabled")).key, "turn_off_recommendations");
  assert.equal(switchOf(flagEntry("backupStoreEnabled")).key, "use_backup_store");
  assert.equal(switchOf(flagEntry("somethingElse")), null);
  assert.equal(switchOf(flagEntry("recommendationsEnabled", "capy")), null);
  assert.equal(switchNamed("toString"), null);
  const r = SWITCHES.recommendationsEnabled;
  assert.equal(r.proposed.fits, "Proposed turning off recommendations to restore booking.");
  assert.equal(`${r.howChecked} The booking screen on a real device is not checked yet.`, "turtl checks that the booking app answers, that recommendations read as off, and then runs the booking check: a test booking must be saved and match its confirmation. The booking screen on a real device is not checked yet.");
  assert.equal(r.handoff, "Service is restored, not repaired: recommendations are off and the coupling is still in the code.");
  const facts = { "journey.verdict": "failed", "journey.failedStep": "recommendations", "journey.errorCode": "RECOMMENDATIONS_TIMEOUT", "flags.recommendationsEnabled": true };
  assert.equal(r.fits(facts), true);
  assert.equal(SWITCHES.backupStoreEnabled.fits(facts), false);
  assert.equal(SWITCHES.backupStoreEnabled.fits({ "journey.verdict": "failed", "journey.failedStep": "submit_booking", "journey.errorCode": "BOOKING_STORE_UNAVAILABLE" }), true);
  const plan = readFileSync(join(root, "convex/runner/handlers/plan.ts"), "utf8");
  assert.match(plan, /loaded\.context\.app\?\.practice \? PRACTICE_DONE_MEANS : DONE_MEANS/, "a practice app's fixes leave the device run out of what done means");
});

test("a practice project's rows go with the project, and its token is turtl's own", () => {
  const registry = createLoader()("convex/account/registry.ts");
  const erased = registry.projectErasers.filter((entry) => entry.kind === "rows").map((entry) => entry.table);
  for (const table of ["practiceApps", "practiceBookings", "secrets", "journeys", "actionCatalog", "watchedProjects"]) assert.ok(erased.includes(table), table);
  const store = readFileSync(join(root, "convex/secrets/store.ts"), "utf8");
  assert.match(store, /Boolean\(app\.practice\) !== Boolean\(managed\)/, "only turtl stores a practice app's token, and an owner's token never lands on one");
  assert.match(readFileSync(join(root, "convex/secrets/project.ts"), "utf8"), /\?\.practice\) throw new ConvexError\(MANAGED_TOKEN\)/);
});

test("the screens say plainly what a practice app has not got, and offer practice only where the backend does", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  assert.match(read("components/practice/PracticeStart.tsx"), /if \(!practice \|\| \(!practice\.available && !practice\.project\)\) return null;/, "nothing in the demo, or while it is not known");
  assert.match(read("components/fix/CasePage.tsx"), /The practice app has no repository, so turtl has no code to map, show or change\. Code changes need a connected repository\./);
  assert.match(read("app/project/[projectId]/investigate.tsx"), /project\?\.practice \? \(\s*<Empty testID="investigate-practice"/);
  assert.match(read("app/project/[projectId]/prepare.tsx"), /testID="prepare-practice"/);
  assert.match(read("app/project/[projectId]/index.tsx"), /project\.practice \? <PracticeTile/);
  assert.match(read("components/project/Watching.tsx"), /!brief && !practice &&/);
  const sheet = read("components/practice/PracticeSheet.tsx");
  for (const id of ["practice-break-confirm", "practice-break-cancel", "practice-choice-", "practice-mend", "practice-mend-confirm", "practice-open-issue"]) assert.ok(sheet.includes(id), id);
  assert.match(read("data/live/projects.ts"), /productionUrl: app\.practice \? undefined : app\.productionUrl/, "no Live app link to turtl's own route");
});
