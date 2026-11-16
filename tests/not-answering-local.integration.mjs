import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { startExpoPushStub } from "./fixtures/expo-push-stub.mjs";

// Proves cases for an app that stops answering (convex/protectedApp/notAnswering.ts) on a real local Convex backend:
// first the single-owner demo, with AUTH_REQUIRED unset on a backend that holds no account yet, then with
// AUTH_REQUIRED=true. Convex's own runtime runs the monitor, the scheduler, fetch, and the request to turtl's own site
// before a case opens. The owner's app is a stand-in this process serves on port 8230, which this proof stops and
// starts again; Expo's push service is tests/fixtures/expo-push-stub.mjs on port 8231. Nothing reaches a real vendor.
// It refuses to run against anything but a local anonymous deployment, and removes the variables it set. Give it a
// fresh local backend: once accounts exist, the demo refuses to serve it.
//
//   CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3330 --local-site-port 3331 --typecheck disable
//   node --test tests/not-answering-local.integration.mjs

const APP_PORT = 8230;
const PUSH_PORT = 8231;
const RUN = Date.now().toString(36);
const root = fileURLToPath(new URL("..", import.meta.url));
assert.match(readFileSync(join(root, ".env.local"), "utf8"), /^CONVEX_DEPLOYMENT=anonymous:/m, "This proof runs only against a local anonymous deployment.");
const config = JSON.parse(readFileSync(join(root, ".convex/local/default/config.json"), "utf8"));
const url = `http://127.0.0.1:${config.ports.cloud}`;
const convex = async (...args) => (await promisify(execFile)("npx", ["convex", ...args], { cwd: root, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } })).stdout;
const client = (subject) => {
  const c = new ConvexHttpClient(url);
  if (subject) c.setAdminAuth(config.adminKey, { subject, issuer: "https://local.test", tokenIdentifier: `https://local.test|${subject}` });
  else c.setAdminAuth(config.adminKey);
  return c;
};
const admin = client();
const anonymous = new ConvexHttpClient(url);
const TOKEN = (name) => `ExponentPushToken[${name}-${RUN}]`;
const BODIES = {
  not_answering: "Your app is not answering turtl's checks. Open the case to see what turtl saw.",
  answering_again: "Your app is answering turtl's checks again. Open the case to see whether they pass.",
};

async function until(read, ok, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (ok(value)) return value;
    await delay(200);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

const passed = { runId: "proof", verdict: "passed", failedStep: null, error: null, steps: [], cleanup: { ok: true, deletedBookings: 0 }, revision: "abc1234", environment: "proof", startedAt: 1, completedAt: 2 };

/**
 * The owner's app: every journey check passes while it runs, and its health route answers 200 with no check result,
 * as a real app's does. stop() closes it, so a check gets no response at all. routesGone: the app is up, but every
 * journey route answers 404 (the owner renamed them), a reply turtl cannot read. journeysDown: the journey routes drop
 * the connection (the app behind a proxy is down) while the health route still answers 200, as a proxy's own would.
 */
function standInApp() {
  const requests = [];
  let server = null;
  const state = { routesGone: false, journeysDown: false };
  const handler = (request, response) => {
    const path = new URL(request.url, "http://stand-in").pathname;
    requests.push({ path, at: Date.now() });
    request.resume();
    request.on("end", () => {
      if (state.journeysDown && path.endsWith("/journey-check")) return request.socket.destroy();
      const gone = state.routesGone && path.endsWith("/journey-check");
      response.writeHead(gone ? 404 : 200, { "Content-Type": "application/json", Connection: "close" });
      response.end(JSON.stringify(gone ? { error: "Not Found" } : path.endsWith("/journey-check") ? passed : { ok: true, service: "proof" }));
    });
  };
  return {
    requests,
    state,
    start: () => new Promise((resolve, reject) => {
      server = createServer(handler);
      server.once("error", reject);
      server.listen(APP_PORT, "127.0.0.1", resolve);
    }),
    stop: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const notAnsweringCases = (snapshot) => snapshot.cases.filter((row) => row.signature?.startsWith("not_answering:"));
const counts = (snapshot) => snapshot.journeys.map((journey) => journey.unanswered?.count ?? 0);
const say = (line) => console.log(`[not-answering proof] ${line}`);

/**
 * Stops the app, then runs rounds with `round` until the case opens, checking at each that nothing the owner can see
 * happened before three tries in a row. Returns the snapshot with the case.
 */
async function untilOpened(round, read, label) {
  for (let n = 1; n <= 10; n++) {
    await round();
    // The cron's own round may be between counting its third try and opening the case (it asks turtl's own site first):
    // wait for it to finish deciding.
    const snapshot = await until(read, (s) => notAnsweringCases(s).length > 0 || Math.max(...counts(s)) < 3, `${label}: a round decided`, 15_000);
    const opened = notAnsweringCases(snapshot).filter((row) => row.status === "waiting_for_app");
    say(`${label}: round ${n} with the app stopped: tries in a row ${JSON.stringify(counts(snapshot))}, open not-answering cases ${opened.length}`);
    if (opened.length) {
      assert.ok(Math.max(...counts(snapshot)) >= 3, "it opened only at three tries in a row");
      return snapshot;
    }
    assert.ok(Math.max(...counts(snapshot)) < 3, `no case at ${JSON.stringify(counts(snapshot))}`);
    assert.deepEqual(notAnsweringCases(snapshot), [], "fewer than three tries in a row open nothing");
  }
  throw new Error(`${label}: no case opened in ten rounds`);
}

test("cases for an app that stops answering, on a local Convex backend", { timeout: 600_000 }, async (t) => {
  const app = standInApp();
  await app.start();
  const expo = await startExpoPushStub({ port: PUSH_PORT });
  const set = { DEV_TOOLS_ENABLED: "true", EXPO_PUSH_API_URL: expo.url };
  for (const [name, value] of Object.entries(set)) await convex("env", "set", name, value);
  const DEMO = { PROTECTED_APP_URL: `http://127.0.0.1:${APP_PORT}/demo-${RUN}`, PROTECTED_APP_CONTROL_SECRET: "demo-proof-" + randomBytes(6).toString("hex") };
  const ACCOUNTS = { AUTH_REQUIRED: "true", WATCHED_APP_ALLOW_LOOPBACK: "true" };
  t.after(async () => {
    await app.stop().catch(() => {});
    await expo.close();
    for (const name of [...Object.keys(set), ...Object.keys(DEMO), ...Object.keys(ACCOUNTS)]) await convex("env", "remove", name).catch(() => {});
  });

  await t.test("the single-owner demo: three ticks with no answer open one case and tell the owner; the app answering closes it and tells them again", async () => {
    await anonymous.query(ref("ownerPasscode:status"), {}).catch((error) => {
      if (/turtl is unavailable right now/.test(String(error?.data ?? error?.message))) throw new Error("This backend already holds accounts. Stop it, remove .convex/local/default, start it again, and run this once more.");
      throw error;
    });
    for (const [name, value] of Object.entries(DEMO)) await convex("env", "set", name, value);
    await delay(1500);
    const { appId } = await admin.mutation(ref("protectedApp/registry:register"), {});
    await anonymous.mutation(ref("push/devices:register"), { token: TOKEN("demo"), platform: "ios" });
    const read = () => admin.query(ref("protectedApp/localProof:snapshot"), { appId });
    const tick = () => admin.action(ref("monitor:tick"), {});
    await tick();
    await until(read, (s) => s.journeys.every((journey) => journey.lastPassedAt), "the demo's check passed");

    await app.stop();
    say("demo: the stand-in app stopped");
    const opened = await untilOpened(tick, read, "demo");
    const [row] = notAnsweringCases(opened);
    say(`demo: case opened: status ${row.status}, signature ${row.signature}, title "${row.title}"`);
    const told = await until(read, (s) => notAnsweringCases(s)[0].notices.length && notAnsweringCases(s)[0].pushes[0]?.outcome === "sent", "the demo's owner was told");
    assert.deepEqual(notAnsweringCases(told)[0].notices.map((notice) => notice.event), ["not_answering"]);
    assert.deepEqual(expo.sends().at(-1).body.map((message) => [message.body, message.data.caseId]), [[BODIES.not_answering, row._id]]);
    say(`demo: notice not_answering recorded; push sent: "${expo.sends().at(-1).body[0].body}"`);

    await app.start();
    say("demo: the stand-in app started again");
    await tick();
    const closed = await until(read, (s) => notAnsweringCases(s)[0].status === "resolved" && notAnsweringCases(s)[0].pushes.some((push) => push.event === "answering_again" && push.outcome === "sent"), "the demo's case closed");
    const done = notAnsweringCases(closed)[0];
    assert.deepEqual(done.notices.map((notice) => notice.event).sort(), ["answering_again", "not_answering"]);
    assert.deepEqual(counts(closed), [0]);
    assert.match(done.attempts[0].summary, /^The app answered turtl's checks again after about/);
    assert.equal(expo.sends().at(-1).body[0].body, BODIES.answering_again);
    say(`demo: case ${done.status}: "${done.attempts[0].summary}"`);
    say(`demo: notice answering_again recorded; push sent: "${expo.sends().at(-1).body[0].body}"`);
    for (const name of Object.keys(DEMO)) await convex("env", "remove", name);
  });

  await t.test("with accounts on: three rounds with no answer open one case for the project, which shows its checks not answering; the app answering closes it", async () => {
    for (const [name, value] of Object.entries(ACCOUNTS)) await convex("env", "set", name, value);
    await delay(1500);
    // Two real checks, and the project's health route registered as a journey beside them, as onboarding does.
    const seeded = await admin.mutation(ref("protectedApp/localProof:seed"), { email: `ada-${RUN}@proof.test`, liveUrl: `http://127.0.0.1:${APP_PORT}/a-${RUN}`, checks: 2, run: RUN, health: true });
    const ada = client(`${seeded.account}|${seeded.sessionId}`);
    await ada.mutation(ref("push/devices:register"), { token: TOKEN("ada"), platform: "ios" });
    const read = () => admin.query(ref("protectedApp/localProof:snapshot"), { appId: seeded.appId });
    const overview = async () => (await ada.query(ref("screens/overview:forProject"), { projectId: seeded.appId })).checks;
    // One round of the project's checks, as the monitor's cron starts it (monitor:checkProject). The cron may take a turn
    // of its own in between; every count and case below is read back, never assumed.
    const round = () => admin.action(ref("monitor:checkProject"), { appId: seeded.appId });
    const first = await round();
    assert.deepEqual(first.checked.map((check) => check.outcome), ["passed", "passed", "check_error"], "the health route gives the monitor no check result");

    // While the app is up, its health route's reply with no check result never counts, however many rounds.
    for (let n = 0; n < 5; n++) await round();
    const up = await read();
    assert.deepEqual([counts(up), notAnsweringCases(up)], [[0, 0, 0], []]);
    assert.ok((await overview()).every((check) => check.state === "passing" && !check.notAnswering));
    say(`accounts: 6 rounds with the app up and its health route answering 200 with no check result: tries in a row ${JSON.stringify(counts(up))}, not-answering cases ${notAnsweringCases(up).length}`);

    // The app is up, but both journey routes answer 404 (renamed in turtl.json): a reply turtl cannot read, which counts
    // for nothing either way. Nothing opens.
    app.state.routesGone = true;
    const gone = [];
    for (let n = 0; n < 5; n++) gone.push((await round()).checked.map((check) => check.outcome));
    assert.ok(gone.every((outcomes) => outcomes.every((outcome) => outcome === "check_error")), "turtl cannot run any check there");
    const after404 = await read();
    assert.deepEqual([counts(after404), notAnsweringCases(after404)], [[0, 0, 0], []]);
    assert.ok((await overview()).every((check) => !check.notAnswering));
    say(`accounts: 5 rounds with the app up and both journey routes answering 404: tries in a row ${JSON.stringify(counts(after404))}, not-answering cases ${notAnsweringCases(after404).length}`);
    app.state.routesGone = false;
    await round();

    // The app behind the stand-in goes down: its journey routes give no response, its health route still answers 200.
    app.state.journeysDown = true;
    say("accounts: the stand-in's journey routes stopped answering; its health route still answers 200");
    const before = await overview();
    assert.ok(before.every((check) => check.state === "passing" && !check.notAnswering));
    const opened = await untilOpened(async () => {
      await round();
      // Below three in a row the project shows nothing new (read between two snapshots that agree it is below three).
      const below = (s) => !notAnsweringCases(s).length && Math.max(...counts(s)) < 3;
      const earlier = await read();
      const shown = await overview();
      if (below(earlier) && below(await read())) assert.ok(shown.every((check) => check.state === "passing" && !check.notAnswering), JSON.stringify(shown));
    }, read, "accounts");
    const [row] = notAnsweringCases(opened);
    assert.deepEqual(
      { kind: row.kind, raisedBy: row.raisedBy, journeyId: row.journeyId ?? null, signature: row.signature, status: row.status, passingForMs: row.passingForMs ?? null },
      { kind: "outage", raisedBy: "monitor", journeyId: null, signature: `not_answering:${seeded.appId}`, status: "waiting_for_app", passingForMs: null },
    );
    assert.deepEqual([row.steps.map((step) => step.status), row.attempts.map((attempt) => attempt.status)], [["waiting"], ["waiting"]]);
    say(`accounts: case opened: status ${row.status}, signature ${row.signature}, one step ${row.steps[0].status}`);
    say(`accounts: what the case says: "${row.impact}"`);
    assert.match(row.impact, /^At least three tries in a row of each of 2 checks \("Book 1" and "Book 2"\) got no usable answer/, "it names the real checks only");
    const shown = await overview();
    const [health, ...real] = [shown.find((check) => check.name === "Health"), ...shown.filter((check) => check.name !== "Health")];
    assert.ok(real.every((check) => check.state === "failing" && check.notAnswering?.tries >= 3), JSON.stringify(shown));
    assert.deepEqual([health.state, health.notAnswering], ["passing", undefined], "the health journey is shown as before");
    say(`accounts: the project shows ${JSON.stringify(shown.map((check) => ({ name: check.name, state: check.state, notAnswering: check.notAnswering })))}`);
    const told = await until(read, (s) => notAnsweringCases(s)[0].pushes[0]?.outcome === "sent", "Ada was told");
    assert.deepEqual(notAnsweringCases(told)[0].notices.map((notice) => notice.event), ["not_answering"]);
    const toAda = expo.sends().filter((send) => send.body.some((message) => message.to === TOKEN("ada")));
    assert.deepEqual(toAda.at(-1).body.map((message) => [message.title, message.body, message.data.caseId]), [["Proof shop", BODIES.not_answering, row._id]]);
    say(`accounts: notice not_answering recorded; push sent to Ada's phone: "${toAda.at(-1).body[0].body}"`);

    // More rounds with no answer open nothing more.
    await round();
    assert.equal(notAnsweringCases(await read()).length, 1);

    app.state.journeysDown = false;
    say("accounts: the stand-in's journey routes answer again");
    await round();
    const closed = await until(read, (s) => notAnsweringCases(s)[0].status === "resolved" && notAnsweringCases(s)[0].pushes.some((push) => push.event === "answering_again" && push.outcome === "sent"), "Ada's case closed");
    const done = notAnsweringCases(closed)[0];
    assert.equal(notAnsweringCases(closed).length, 1);
    assert.deepEqual(done.notices.map((notice) => notice.event).sort(), ["answering_again", "not_answering"]);
    assert.deepEqual(counts(closed), [0, 0, 0]);
    assert.match(done.attempts[0].summary, /Its checks pass now\.$/);
    assert.ok((await overview()).every((check) => check.state === "passing" && !check.notAnswering));
    const again = expo.sends().filter((send) => send.body.some((message) => message.to === TOKEN("ada"))).at(-1);
    assert.equal(again.body[0].body, BODIES.answering_again);
    say(`accounts: case ${done.status}: "${done.attempts[0].summary}"`);
    say(`accounts: notice answering_again recorded; push sent to Ada's phone: "${again.body[0].body}"`);
  });
});
