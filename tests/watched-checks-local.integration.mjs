import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

// Proves, on a real local Convex backend with accounts on, what tests/watched-checks.test.mjs holds in memory:
// a project's health and readiness checks are sent as GETs and read as what they are, and a check that turtl.json no
// longer lists is retired when the owner taps Check again. Convex's own runtime runs the registration (which reads
// turtl.json from a stand-in for GitHub), the monitor's rounds, fetch, the two index reads that leave retired checks
// out, and the request to turtl's own site before a case opens. The owner's app is a stand-in this process serves on
// port 8230, with a health route, a readiness route and journey routes it can stop, make "not ready", or hide behind
// a proxy that still answers /health. GitHub is a stand-in on port 8232 and Expo's push service
// tests/fixtures/expo-push-stub.mjs on port 8231. Nothing reaches a real vendor. It refuses to run against anything but
// a local anonymous deployment, and removes the variables it set.
//
//   CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3330 --local-site-port 3331 --typecheck disable
//   node --test tests/watched-checks-local.integration.mjs

const APP_PORT = 8230;
const PUSH_PORT = 8231;
const GITHUB_PORT = 8232;
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
const TOKEN = (name) => `ExponentPushToken[${name}-${RUN}]`;
const say = (line) => console.log(`[watched-checks proof] ${line}`);

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
 * The owners' apps, one per path prefix. Each has /health, /ready and journey routes under /checks/. A prefix's
 * `mode`: "up"; "down" (every route drops the connection); "not_ready" (/ready answers 503 with a body, the rest are
 * up); "behind_proxy" (the app is gone, so journey and readiness routes drop the connection, while the proxy in front
 * still answers /health with a 200 of its own).
 */
function standInApps() {
  const requests = [];
  const modes = new Map();
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://stand-in").pathname;
    const [, prefix, ...rest] = path.split("/");
    const route = `/${rest.join("/")}`;
    requests.push({ prefix, route, method: request.method, at: Date.now() });
    request.resume();
    request.on("end", () => {
      const mode = modes.get(prefix) ?? "up";
      const reply = (status, body) => {
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify(body));
      };
      if (mode === "down" || (mode === "behind_proxy" && route !== "/health")) return request.socket.destroy();
      if (route === "/health") return request.method === "GET" ? reply(200, { ok: true, service: "proof" }) : reply(405, { error: "Method Not Allowed" });
      if (route === "/ready") {
        if (request.method !== "GET") return reply(405, { error: "Method Not Allowed" });
        return mode === "not_ready" ? reply(503, { ready: false, waitingFor: "database" }) : reply(200, { ready: true });
      }
      if (route.endsWith("/journey-check")) return request.method === "POST" ? reply(200, passed) : reply(405, { error: "Method Not Allowed" });
      return reply(404, { error: "Not Found" });
    });
  });
  return {
    requests,
    set: (prefix, mode) => modes.set(prefix, mode),
    to: (prefix, route) => requests.filter((request) => request.prefix === prefix && request.route === route),
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(APP_PORT, "127.0.0.1", resolve);
    }),
    stop: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/**
 * GitHub: the latest commit on each branch of each repository, its default branch, and turtl.json at each commit.
 * rename(): main is renamed, as when a repository moves from one default branch name to another.
 */
function standInGithub() {
  const repos = new Map();
  const requests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://github").pathname;
    requests.push(path);
    const send = (status, body, type = "application/json") => {
      response.writeHead(status, { "Content-Type": type });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const meta = path.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (meta && repos.has(meta[1])) return send(200, { default_branch: repos.get(meta[1]).branch });
    const commit = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/);
    if (commit && repos.get(commit[1])?.branch === decodeURIComponent(commit[2])) return send(200, { sha: repos.get(commit[1]).head });
    const raw = path.match(/^\/raw\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/turtl\.json$/);
    const file = raw && repos.get(raw[1])?.files[raw[2]];
    if (file) return send(200, file, "text/plain");
    return send(404, { message: "Not Found" });
  });
  return {
    requests,
    repo: (name, head, files) => repos.set(name, { head, files, branch: "main" }),
    rename: (name, branch) => { repos.get(name).branch = branch; },
    push: (name, head, file) => {
      const repo = repos.get(name);
      repo.head = head;
      repo.files[head] = file;
    },
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(GITHUB_PORT, "127.0.0.1", resolve);
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const sha = (digit) => String(digit).repeat(40);
const manifest = ({ health = true, readiness = true, journeys = [] }) =>
  JSON.stringify({
    version: 1,
    ...(health && { health: { name: "Server answers", path: "/health" } }),
    ...(readiness && { readiness: { name: "Ready to take bookings", path: "/ready" } }),
    journeys: journeys.map((name) => ({ name, path: `/checks/${name.toLowerCase()}/journey-check` })),
  });

const notAnsweringCases = (snapshot) => snapshot.cases.filter((row) => row.signature?.startsWith("not_answering:"));
const ordinaryCases = (snapshot) => snapshot.cases.filter((row) => row.signature?.startsWith("journey_failed:"));
const live = (snapshot) => snapshot.journeys.filter((journey) => journey.retiredAt === null);
const named = (snapshot, name) => snapshot.journeys.find((journey) => journey.name === name);
const tries = (snapshot) => Object.fromEntries(live(snapshot).map((journey) => [journey.name, journey.unanswered?.count ?? 0]));

test("health and readiness checks, and the retiring of a check, on a local Convex backend", { timeout: 600_000 }, async (t) => {
  const apps = standInApps();
  const github = standInGithub();
  await apps.start();
  await github.start();
  const expo = await startExpoPushStub({ port: PUSH_PORT });
  const set = { DEV_TOOLS_ENABLED: "true", EXPO_PUSH_API_URL: expo.url, AUTH_REQUIRED: "true", WATCHED_APP_ALLOW_LOOPBACK: "true", GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}` };
  for (const [name, value] of Object.entries(set)) await convex("env", "set", name, value);
  await delay(1500);
  t.after(async () => {
    await apps.stop().catch(() => {});
    await github.stop().catch(() => {});
    await expo.close();
    for (const name of Object.keys(set)) await convex("env", "remove", name).catch(() => {});
  });

  /** An owner, their phone, and a project prepared through onboarding whose repository holds this turtl.json. */
  async function owner(name, file) {
    const prefix = `${name}-${RUN}`;
    const repo = `proof/${prefix}`;
    github.repo(repo, sha(1), { [sha(1)]: file });
    const seeded = await admin.mutation(ref("protectedApp/localProof:seed"), { email: `${prefix}@proof.test`, liveUrl: `http://127.0.0.1:${APP_PORT}/${prefix}`, checks: 0, run: RUN, repo, mergeCommit: sha(1) });
    const as = client(`${seeded.account}|${seeded.sessionId}`);
    await as.mutation(ref("push/devices:register"), { token: TOKEN(name), platform: "ios" });
    const read = () => admin.query(ref("protectedApp/localProof:snapshot"), { appId: seeded.appId });
    const overview = async () => Object.fromEntries((await as.query(ref("screens/overview:forProject"), { projectId: seeded.appId })).checks.map((check) => [check.name, check]));
    // One round of the project's checks, as the monitor's cron starts it. The cron may take a turn of its own in
    // between; every count and case below is read back, never assumed.
    const round = async () => (await admin.action(ref("monitor:checkProject"), { appId: seeded.appId })).checked.map((check) => check.outcome);
    const pushesTo = () => expo.sends().flatMap((send) => send.body).filter((message) => message.to === TOKEN(name)).map((message) => message.body);
    /**
     * Rounds until the not-answering case is open. `deciding`: the checks that decide for this project; while any of
     * them has fewer than three tries in a row, nothing may be open.
     */
    const untilOpened = async (deciding) => {
      const open = (s) => notAnsweringCases(s).filter((row) => row.status === "waiting_for_app");
      const fewest = (s) => Math.min(...deciding.map((check) => tries(s)[check] ?? 0));
      for (let n = 1; n <= 10; n++) {
        await round();
        // The round may be between counting its third try and opening the case (it asks turtl's own site first).
        const snapshot = await until(read, (s) => open(s).length > 0 || fewest(s) < 3, `${name}: a round decided`, 15_000);
        if (open(snapshot).length) {
          assert.ok(fewest(snapshot) >= 3, `${name}: it opened only with every deciding check at three in a row`);
          return snapshot;
        }
        assert.deepEqual(open(snapshot), [], `${name}: nothing opens while a deciding check is below three in a row`);
      }
      throw new Error(`${name}: no case opened in ten rounds`);
    };
    return { ...seeded, prefix, repo, as, read, overview, round, pushesTo, untilOpened };
  }

  await t.test("registration writes the health and readiness checks as GET probes, the monitor sends them as GETs, and each pass moves when it last passed", async () => {
    const ada = await owner("ada", manifest({}));
    const registered = await admin.action(ref("onboarding/prepare:register"), { preparationId: ada.preparationId });
    assert.equal(registered.outcome, "registered");
    say(`registration: ${JSON.stringify(registered.checks)}`);
    const first = await ada.read();
    assert.deepEqual(first.journeys.map((journey) => [journey.name, journey.method, journey.probe, journey.checkVersion, journey.lastPassedAt !== null]), [
      ["Server answers", "GET", "health", `onboarding-manifest-v1:${sha(1).slice(0, 12)}`, true],
      ["Ready to take bookings", "GET", "readiness", `onboarding-manifest-v1:${sha(1).slice(0, 12)}`, true],
    ]);
    const registeredAt = named(first, "Server answers").lastPassedAt;
    await delay(1100);
    assert.deepEqual(await ada.round(), ["passed", "passed"]);
    assert.deepEqual(await ada.round(), ["passed", "passed"]);
    const after = await ada.read();
    assert.ok(named(after, "Server answers").lastPassedAt > registeredAt && named(after, "Ready to take bookings").lastPassedAt > registeredAt, "each pass moved it on from the time registration wrote");
    // Every request the monitor's rounds made to the two routes was a GET (registration's own probe is a GET too).
    assert.deepEqual([...new Set(apps.to(ada.prefix, "/health").map((request) => request.method)), ...new Set(apps.to(ada.prefix, "/ready").map((request) => request.method))], ["GET", "GET"]);
    const shown = await ada.overview();
    assert.deepEqual(Object.values(shown).map((check) => [check.name, check.kind, check.state]), [["Server answers", "health", "passing"], ["Ready to take bookings", "readiness", "passing"]]);
    say(`probe-only project: rounds return ${JSON.stringify(await ada.round())}; ${apps.to(ada.prefix, "/health").length} requests to /health and ${apps.to(ada.prefix, "/ready").length} to /ready, all GET; the project shows ${JSON.stringify(Object.values(shown).map((check) => `${check.name}: ${check.state}`))}`);

    // The app says it is not ready: the readiness check shows "not ready" at three in a row. The health check still
    // passes, so nothing opens and nobody is told.
    apps.set(ada.prefix, "not_ready");
    assert.deepEqual(await ada.round(), ["passed", "failed"]);
    await ada.round();
    const two = await ada.overview();
    assert.equal(two["Ready to take bookings"].state, "passing", "two in a row show nothing");
    await ada.round();
    const three = await until(ada.overview, (checks) => checks["Ready to take bookings"].state === "failing", "the readiness check shows");
    assert.deepEqual([three["Ready to take bookings"].notAnswering.notReady, three["Ready to take bookings"].notAnswering.tries >= 3, three["Server answers"].state], [true, true, "passing"]);
    const unready = await ada.read();
    assert.deepEqual([notAnsweringCases(unready), ordinaryCases(unready), ada.pushesTo()], [[], [], []]);
    assert.deepEqual(named(unready, "Ready to take bookings").unanswered.latest, { kind: "not_ready" });
    say(`not ready: the app answered /ready with 503 and a body ${tries(unready)["Ready to take bookings"]} times in a row; the project shows ${JSON.stringify(Object.values(three).map((check) => `${check.name}: ${check.state}${check.notAnswering?.notReady ? " (not ready)" : ""}`))}; cases 0, pushes 0`);

    // The app stops: both probes get no response. This project has no journey check, so its probes decide.
    apps.set(ada.prefix, "down");
    const opened = await ada.untilOpened(["Server answers", "Ready to take bookings"]);
    const [row] = notAnsweringCases(opened);
    assert.deepEqual([row.status, row.kind, row.raisedBy, row.journeyId ?? null, row.title], ["waiting_for_app", "outage", "monitor", null, "Your app stopped answering"]);
    assert.match(row.impact, /^At least three tries in a row of each of 2 checks \("Server answers" and "Ready to take bookings"\) got no usable answer: turtl could not connect to the app\.$/);
    await until(ada.read, (s) => notAnsweringCases(s)[0].pushes[0]?.outcome === "sent", "Ada was told");
    assert.deepEqual(ada.pushesTo(), ["Your app is not answering turtl's checks. Open the case to see what turtl saw."]);
    assert.deepEqual(ordinaryCases(await ada.read()), [], "a probe opens no ordinary case");
    say(`app stopped: case opened, "${row.title}": "${row.impact}"; push: "${ada.pushesTo().at(-1)}"`);

    apps.set(ada.prefix, "up");
    await ada.round();
    const closed = await until(ada.read, (s) => notAnsweringCases(s)[0].status === "resolved" && notAnsweringCases(s)[0].pushes.some((push) => push.event === "answering_again" && push.outcome === "sent"), "Ada's case closed");
    assert.match(notAnsweringCases(closed)[0].attempts[0].summary, /Its checks pass now\.$/);
    assert.deepEqual([notAnsweringCases(closed).length, Object.values(tries(closed)), ada.pushesTo().length], [1, [0, 0], 2]);
    say(`app back: case ${notAnsweringCases(closed)[0].status}: "${notAnsweringCases(closed)[0].attempts[0].summary}"; push: "${ada.pushesTo().at(-1)}"`);
  });

  await t.test("beside journey checks that have passed, a proxy's own 200 on /health neither stops the case nor closes it", async () => {
    const bea = await owner("bea", manifest({ journeys: ["Book", "Cancel"] }));
    await admin.action(ref("onboarding/prepare:register"), { preparationId: bea.preparationId });
    assert.deepEqual(await bea.round(), ["passed", "passed", "passed", "passed"]);
    apps.set(bea.prefix, "behind_proxy");
    const opened = await bea.untilOpened(["Book", "Cancel"]);
    const [row] = notAnsweringCases(opened);
    assert.match(row.impact, /^At least three tries in a row of each of 2 checks \("Book" and "Cancel"\) got no usable answer/, "it names the journey checks only");
    const healthAt = named(opened, "Server answers").lastPassedAt;
    for (let n = 0; n < 4; n++) await bea.round();
    const still = await bea.read();
    assert.deepEqual([notAnsweringCases(still).map((one) => one.status), named(still, "Server answers").lastPassedAt > healthAt], [["waiting_for_app"], true], "the health check went on passing, and the case stayed open");
    const shown = await bea.overview();
    assert.deepEqual([shown["Server answers"].state, shown.Book.state, shown.Cancel.state, shown["Ready to take bookings"].state], ["passing", "failing", "failing", "failing"]);
    say(`behind a proxy: /health answered 200 on every round; case "${row.title}" opened on the journey checks and stayed open through ${4} more rounds; the project shows ${JSON.stringify(Object.values(shown).map((check) => `${check.name}: ${check.state}`))}`);
    apps.set(bea.prefix, "up");
    await bea.round();
    await until(bea.read, (s) => notAnsweringCases(s)[0].status === "resolved", "Bea's case closed");
  });

  await t.test("a check turtl.json no longer lists is retired at Check again: not sent, not shown, and listing it again revives the same row", async () => {
    const cy = await owner("cy", manifest({ journeys: ["Book", "Cancel"] }));
    await admin.action(ref("onboarding/prepare:register"), { preparationId: cy.preparationId });
    await cy.round();
    const before = await cy.read();
    assert.deepEqual(live(before).map((journey) => journey.name), ["Server answers", "Ready to take bookings", "Book", "Cancel"]);
    const cancel = named(before, "Cancel");
    assert.equal(before.registration.ref, sha(1));

    // The owner takes Cancel out of turtl.json on main, and taps Check again.
    github.push(cy.repo, sha(2), manifest({ journeys: ["Book"] }));
    await cy.as.mutation(ref("onboarding/projects:checkAgain"), { projectId: cy.appId });
    const after = await until(cy.read, (s) => s.registration?.status === "done" && s.registration.ref === sha(2), "Check again read the branch's head");
    assert.ok(github.requests.includes(`/repos/${cy.repo}/commits/main`) && github.requests.includes(`/raw/${cy.repo}/${sha(2)}/turtl.json`));
    assert.deepEqual(live(after).map((journey) => journey.name), ["Server answers", "Ready to take bookings", "Book"]);
    assert.deepEqual([typeof named(after, "Cancel").retiredAt, named(after, "Cancel").id, named(after, "Cancel").unanswered], ["number", cancel.id, null], "the row is kept, marked");
    assert.equal(after.registration.note, 'turtl stopped checking "Cancel": turtl.json no longer lists it.');
    assert.deepEqual(named(after, "Book").checkVersion, named(before, "Book").checkVersion, "a check whose address did not change keeps its version");
    const sentBefore = apps.to(cy.prefix, "/checks/cancel/journey-check").length;
    for (let n = 0; n < 3; n++) assert.deepEqual(await cy.round(), ["passed", "passed", "passed"]);
    assert.equal(apps.to(cy.prefix, "/checks/cancel/journey-check").length, sentBefore, "not one more request reaches it");
    assert.deepEqual(Object.keys(await cy.overview()), ["Server answers", "Ready to take bookings", "Book"]);
    say(`retired: Check again read turtl.json at ${sha(2).slice(0, 7)}; note: "${after.registration.note}"; 3 rounds sent ${JSON.stringify(["Server answers", "Ready to take bookings", "Book"])} and nothing to Cancel; the project lists ${JSON.stringify(Object.keys(await cy.overview()))}`);

    // A retired check cannot stop the case: Cancel's route still passes on the app, but turtl no longer asks it.
    apps.set(cy.prefix, "down");
    const opened = await cy.untilOpened(["Book"]);
    assert.match(notAnsweringCases(opened)[0].impact, /^At least three tries in a row of the "Book" check got no usable answer/);
    apps.set(cy.prefix, "up");
    await cy.round();
    await until(cy.read, (s) => notAnsweringCases(s)[0].status === "resolved", "Cy's case closed");

    // Listed again: the same row, with its history.
    github.push(cy.repo, sha(3), manifest({ journeys: ["Book", "Cancel"] }));
    await admin.action(ref("onboarding/prepare:register"), { preparationId: cy.preparationId, latest: true });
    const revived = await cy.read();
    assert.deepEqual([named(revived, "Cancel").id, named(revived, "Cancel").retiredAt, revived.journeys.filter((journey) => journey.name === "Cancel").length, revived.registration.note ?? null], [cancel.id, null, 1, null]);
    assert.deepEqual(await cy.round(), ["passed", "passed", "passed", "passed"]);
    say(`listed again at ${sha(3).slice(0, 7)}: the same row is back (${named(revived, "Cancel").id === cancel.id}), and a round sends all four checks`);

    // A registration that ends after a newer one was started writes nothing. The owner's Check again above named its
    // start; a run that names an earlier start is the older one, whatever turtl.json now says.
    github.push(cy.repo, sha(4), manifest({ journeys: ["Book"] }));
    const startedAt = revived.registration.startedAt;
    assert.equal(typeof startedAt, "number", "the owner's Check again named its start");
    await admin.action(ref("onboarding/prepare:register"), { preparationId: cy.preparationId, latest: true, startedAt: startedAt - 60_000 });
    const afterStale = await cy.read();
    assert.deepEqual([live(afterStale).map((journey) => journey.name), afterStale.registration.ref], [["Server answers", "Ready to take bookings", "Book", "Cancel"], sha(3)], "the older run changed nothing");
    say(`a registration naming an earlier start, run after turtl.json dropped Cancel again at ${sha(4).slice(0, 7)}: nothing changed (still ${JSON.stringify(live(afterStale).map((journey) => journey.name))}, read at ${afterStale.registration.ref.slice(0, 7)})`);

    // The preparation's branch is renamed: Check again reads the repository's default branch instead of failing.
    github.rename(cy.repo, "trunk");
    const renamed = await admin.action(ref("onboarding/prepare:register"), { preparationId: cy.preparationId, latest: true });
    assert.equal(renamed.outcome, "registered");
    const afterRename = await cy.read();
    assert.deepEqual([live(afterRename).map((journey) => journey.name), afterRename.registration.ref, typeof named(afterRename, "Cancel").retiredAt], [["Server answers", "Ready to take bookings", "Book"], sha(4), "number"]);
    assert.ok(github.requests.includes(`/repos/${cy.repo}`) && github.requests.includes(`/repos/${cy.repo}/commits/trunk`));
    say(`main renamed to trunk: registration read the default branch's head ${sha(4).slice(0, 7)} and retired Cancel again`);
  });
});
