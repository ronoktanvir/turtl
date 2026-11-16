import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";

// Proves the single-owner demo with AUTH_REQUIRED unset on a backend that holds no account yet, then per-project control
// tokens, safe addresses, the monitor for every project and the owner's own coding agent on a real local Convex backend
// with AUTH_REQUIRED=true, and last that the demo refuses once accounts exist. Give it a fresh local backend. Convex's own runtime
// runs the functions, the scheduler, Web Crypto and fetch. Every server turtl talks to is a stand-in this process serves
// on one port (8212): two owners' apps (at 127.0.0.1 and at localhost, two origins), Capy, and GitHub. Nothing reaches
// a real vendor. It refuses to run against anything but a local anonymous deployment, and removes what it set.
//
//   CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3320 --local-site-port 3321 --typecheck disable
//   node --test tests/project-secrets-local.integration.mjs

const PORT = 8212;
// Every run uses its own paths and installation ids, so rows a previous run left in the local database never mix in.
const RUN = Date.now().toString(36);
const A = `/a-${RUN}`;
const B = `/b-${RUN}`;
const root = fileURLToPath(new URL("..", import.meta.url));
assert.match(readFileSync(join(root, ".env.local"), "utf8"), /^CONVEX_DEPLOYMENT=anonymous:/m, "This proof runs only against a local anonymous deployment.");
const config = JSON.parse(readFileSync(join(root, ".convex/local/default/config.json"), "utf8"));
const url = `http://127.0.0.1:${config.ports.cloud}`;
const site = `http://127.0.0.1:${config.ports.site}`;
// The stand-in is served by this process, so the Convex CLI must never block it: every call is asynchronous.
const convex = async (...args) => (await promisify(execFile)("npx", ["convex", ...args], { cwd: root, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } })).stdout;
const client = (account) => {
  const c = new ConvexHttpClient(url);
  if (account) c.setAdminAuth(config.adminKey, { subject: `${account}|proof-session`, issuer: "https://local.test", tokenIdentifier: `https://local.test|${account}` });
  else c.setAdminAuth(config.adminKey);
  return c;
};
const admin = client();
const message = (error) => String(error?.data ?? error?.message ?? error);
// The single-owner demo refuses to serve a deployment that holds any account (convex/access.ts).
const UNAVAILABLE = "turtl is unavailable right now. Please try again later.";
const refused = (error) => message(error).includes(UNAVAILABLE);
const onAFreshBackend = async (call) => {
  try {
    return await call();
  } catch (error) {
    if (refused(error)) throw new Error("This backend already holds accounts from an earlier run, and the single-owner demo refuses to serve it. Stop the backend, remove .convex/local/default, start it again, and run this once more.");
    throw error;
  }
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

// ---- The stand-ins ----

const passed = { runId: "proof", verdict: "passed", failedStep: null, error: null, steps: [], cleanup: { ok: true, deletedBookings: 0 }, revision: "abc1234", environment: "proof", startedAt: 1, completedAt: 2 };
const manyEntries = (n, prefix, field) => Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i}`, path: `/${prefix}/${i}`, authenticated: true, ...(field && { field: "recommendationsEnabled" }) }));
// Paths are relative to the live address, which already ends in Alice's prefix.
const manifest = JSON.stringify({ version: 1, credentialRef: "PROTECTED_APP_CONTROL_SECRET", health: { path: "/health" }, journeys: manyEntries(1000, "journey"), flags: manyEntries(1000, "flag", true) });

function startStandIns() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const path = new URL(request.url, "http://stand-in").pathname;
      const entry = { host: request.headers.host, path, method: request.method, authorization: request.headers.authorization ?? null, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(entry);
      const reply = (status, body, headers = {}) => {
        response.writeHead(status, { "Content-Type": "application/json", ...headers });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      // Capy.
      if (path === "/capy/api/v1/projects") return reply(200, { items: [{ id: "capy-proof", repos: [{ repoFullName: "alice/shop" }, { repoFullName: "bob/salon" }] }] });
      if (path === "/capy/api/v1/threads") return reply(200, { id: "thread-proof-" + requests.length });
      if (path.startsWith("/capy/")) return reply(200, { status: "running", items: [] });
      // GitHub: no installation covers anything turtl's records do not; turtl.json at the merge commit.
      if (path.endsWith("/installation")) return reply(404, { message: "Not Found" });
      if (path === "/github/raw/alice/shop/merged-sha/turtl.json") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        return response.end(manifest);
      }
      // Before turtl changes a repository for someone it asks GitHub who they are now (by the id they connected with)
      // and whether they may write to it (convex/github/permission.ts): Alice, user 1, may write to alice/shop.
      if (path === "/github/user/1") return reply(200, { login: "alice", id: 1 });
      if (path === "/github/repos/alice/shop/collaborators/alice/permission") return reply(200, { permission: "write", user: { login: "alice", id: 1 } });
      if (path.startsWith("/github/")) return reply(404, { message: "Not Found" });
      // The owners' apps.
      if (path.endsWith("/moved")) return reply(302, undefined, { Location: `http://localhost:${PORT}/steal` });
      if (path.endsWith("/journey-check") || /\/journey\/\d+$/.test(path)) return reply(200, passed);
      if (path.endsWith("/errors")) return reply(200, { window: { since: 0, until: 1, truncated: false }, counts: { totalBookings: 0, failedBookings: 0, successfulBookings: 0, errorRate: 0 }, errors: [] });
      if (/\/flag\/\d+$/.test(path)) return reply(200, { recommendationsEnabled: true });
      return reply(200, { ok: true });
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve({ requests, close: () => new Promise((done) => server.close(done)) })));
}

const VARIABLES = {
  AUTH_REQUIRED: "true",
  DEV_TOOLS_ENABLED: "true",
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  WATCHED_APP_ALLOW_LOOPBACK: "true",
  CAPY_API_URL: `http://127.0.0.1:${PORT}/capy/api/v1`,
  GITHUB_API_URL: `http://127.0.0.1:${PORT}/github`,
  GITHUB_APP_ID: "424242",
  GITHUB_APP_SLUG: "turtl-proof",
  GITHUB_APP_WEBHOOK_SECRET: randomBytes(16).toString("hex"),
  // Both deployment-wide secrets are set: neither may ever leave for an account's project.
  PROTECTED_APP_CONTROL_SECRET: "deployment-control-secret-" + randomBytes(6).toString("hex"),
  CAPY_API_KEY: "deployment-capy-key-" + randomBytes(6).toString("hex"),
};
const DEMO = ["PROTECTED_APP_URL", "PROTECTED_APP_CONTROL_SECRET_SHA256"];

test("per-project secrets on a local Convex backend", { timeout: 600_000 }, async (t) => {
  const standIns = await startStandIns();
  const scratch = mkdtempSync(join(tmpdir(), "turtl-secrets-proof-"));
  const keyFile = join(scratch, "app.pem");
  writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
  // Everything but AUTH_REQUIRED first: the single-owner demo, on a backend that holds no account yet.
  for (const [name, value] of Object.entries(VARIABLES)) if (name !== "AUTH_REQUIRED") await convex("env", "set", name, value);
  await convex("env", "set", "GITHUB_APP_PRIVATE_KEY", "--from-file", keyFile);
  t.after(async () => {
    await standIns.close();
    for (const name of [...Object.keys(VARIABLES), "GITHUB_APP_PRIVATE_KEY", ...DEMO]) await convex("env", "remove", name).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  });
  const { requests } = standIns;
  const sent = (filter) => requests.filter(filter);
  const leaked = () => JSON.stringify(requests).includes(VARIABLES.PROTECTED_APP_CONTROL_SECRET) || JSON.stringify(requests).includes(VARIABLES.CAPY_API_KEY);

  await t.test("with AUTH_REQUIRED unset and no account yet, the demo monitor checks the booking demo with the deployment's own token, as before", async () => {
    await onAFreshBackend(() => admin.query(ref("ownerPasscode:status"), {}));
    await convex("env", "set", "PROTECTED_APP_URL", `${site}/booking-demo`);
    await convex("env", "set", "PROTECTED_APP_CONTROL_SECRET_SHA256", createHash("sha256").update(VARIABLES.PROTECTED_APP_CONTROL_SECRET).digest("hex"));
    const { appId } = await admin.mutation(ref("protectedApp/registry:register"), {});
    const result = await admin.action(ref("monitor:tick"), {});
    const booking = result.checked.filter((c) => c.detail === "The booking check passed.");
    assert.ok(booking.length >= 1, JSON.stringify(result));
    await assert.rejects(admin.action(ref("secrets/project:setControlToken"), { projectId: appId, token: "demo-token" }), (error) => /single-owner demo/.test(message(error)));
    assert.equal(leaked(), false, "the deployment's secret went only to the booking demo on this backend");
    for (const name of DEMO) await convex("env", "remove", name);
  });

  await convex("env", "set", "AUTH_REQUIRED", VARIABLES.AUTH_REQUIRED);
  await delay(1500);

  const ALICE_ORIGIN = `http://127.0.0.1:${PORT}`;
  const BOB_ORIGIN = `http://localhost:${PORT}`;
  const [alice, bob] = await admin.mutation(ref("secrets/localProof:seed"), {
    owners: [
      { email: "alice@proof.test", repo: "alice/shop", liveUrl: `${ALICE_ORIGIN}${A}`, connected: true },
      { email: "bob@proof.test", repo: "bob/salon", liveUrl: `${BOB_ORIGIN}${B}`, connected: false },
    ],
    // Alice's app answers a redirect at /moved; Bob's project holds a row aimed at Alice's address.
    extra: [{ owner: 0, name: "Redirects elsewhere", url: `${ALICE_ORIGIN}${A}/moved` }, { owner: 1, name: "Aimed at Alice", url: `${ALICE_ORIGIN}${A}/journey-check` }],
    run: Date.now() % 100_000,
  });
  await admin.mutation(ref("github/tokens:store"), { installationId: alice.installationId, token: "proof-installation-token", expiresAt: Date.now() + 60 * 60_000 });
  const asAlice = client(alice.account);
  const asBob = client(bob.account);
  const TOKENS = { alice: "alice-proof-token-" + randomBytes(8).toString("hex"), bob: "bob-proof-token-" + randomBytes(8).toString("hex") };
  const CAPY = { alice: "alice-capy-proof-" + randomBytes(8).toString("hex"), bob: "bob-capy-proof-" + randomBytes(8).toString("hex") };

  await t.test("a project's token is stored sealed by Convex's Web Crypto, never returned, and only its owner can set it", async () => {
    await asAlice.action(ref("secrets/project:setControlToken"), { projectId: alice.appId, token: TOKENS.alice });
    await asBob.action(ref("secrets/project:setControlToken"), { projectId: bob.appId, token: TOKENS.bob });
    await assert.rejects(asBob.action(ref("secrets/project:setControlToken"), { projectId: alice.appId, token: TOKENS.bob }), (error) => /not available on this account/.test(message(error)));
    const status = await asAlice.query(ref("secrets/project:controlToken"), { projectId: alice.appId });
    assert.equal(status.set, true);
    assert.equal(status.sendsTo, ALICE_ORIGIN);
    assert.ok(!JSON.stringify(status).includes(TOKENS.alice));
    assert.equal(await asBob.query(ref("secrets/project:controlToken"), { projectId: alice.appId }), null);
    const forProject = await asAlice.query(ref("onboarding/projects:forProject"), { projectId: alice.appId });
    assert.ok(!JSON.stringify(forProject).includes(TOKENS.alice));
  });

  await t.test("the monitor checks both owners' projects, each with its own token, only on its own origin, and follows no redirect", async () => {
    // The per-minute cron may take the turn first; either way each project is checked once and hands its turn back.
    await admin.action(ref("monitor:tick"), {});
    await until(async () => await admin.query(ref("secrets/localProof:snapshot"), { appIds: [alice.appId, bob.appId] }), (projects) => projects.every((p) => p.watched?.lastCheckedAt), "both projects finished their check");
    const toAlice = sent((r) => r.host === `127.0.0.1:${PORT}` && r.path.startsWith(A + "/"));
    const toBob = sent((r) => r.host === `localhost:${PORT}` && r.path.startsWith(B + "/"));
    const count = (list, path) => list.filter((r) => r.path === path).length;
    assert.ok(toAlice.length >= 2 && toAlice.every((r) => [A + "/journey-check", A + "/moved"].includes(r.path)), JSON.stringify(toAlice));
    assert.equal(count(toAlice, A + "/journey-check"), count(toAlice, A + "/moved"), "one journey check per run of Alice's project: Bob's row aimed at her address was never sent");
    assert.ok(toAlice.every((r) => r.authorization === "Bearer " + TOKENS.alice), "only Alice's token ever reached Alice's app");
    assert.ok(toBob.length >= 1 && toBob.every((r) => r.path === B + "/journey-check" && r.authorization === "Bearer " + TOKENS.bob));
    assert.deepEqual(sent((r) => r.path === "/steal"), [], "the redirect's target was never requested");
    assert.equal(leaked(), false, "the deployment's control secret never left");
    const projects = await admin.query(ref("secrets/localProof:snapshot"), { appIds: [alice.appId, bob.appId] });
    assert.ok(projects.every((p) => p.journeys.find((j) => j.name === "Book an appointment").lastPassedAt), "both passes were recorded");
    assert.ok(projects.every((p) => p.secrets === 1));
  });

  await t.test("without its token a project is skipped with its reason, and nothing is sent for it", { timeout: 180_000 }, async () => {
    const [aliceBefore] = await admin.query(ref("secrets/localProof:snapshot"), { appIds: [alice.appId] });
    await asBob.mutation(ref("secrets/project:removeControlToken"), { projectId: bob.appId });
    const before = requests.length;
    // Each project has its own next check, a minute after its last one began (convex/protectedApp/watching.ts), so Bob's,
    // checked a moment ago, is not due yet. The monitor reads it again at its next turn, taken by the per-minute cron or
    // by a tick of this proof's, whichever comes first: tick until it has, and read what its owner reads.
    const skipped = [];
    const notice = await until(
      async () => {
        const swept = await admin.action(ref("monitor:tick"), {});
        assert.ok(!swept.skipped.some((s) => s.appId === alice.appId), "Alice's project, which has its token, is never skipped");
        skipped.push(...swept.skipped.filter((s) => s.appId === bob.appId));
        return (await asBob.query(ref("secrets/project:controlToken"), { projectId: bob.appId })).notWatched ?? null;
      },
      (reason) => /No control token is set/.test(reason ?? ""),
      "Bob reads why his project is not checked",
      150_000,
    );
    assert.match(notice, /Add it in this project's Settings, under Control token/);
    // If a tick of this proof's took the turn, it named the reason too (the cron's tick reports to no one).
    for (const skip of skipped) assert.match(skip.reason, /No control token is set/);
    // Alice's project is still checked at its own pace, with her token, while Bob's is not.
    await until(
      async () => (await admin.query(ref("secrets/localProof:snapshot"), { appIds: [alice.appId] }))[0],
      (project) => (project.watched?.lastCheckedAt ?? 0) > (aliceBefore.watched?.lastCheckedAt ?? 0),
      "Alice's project was checked again",
      150_000,
    );
    await delay(1500);
    assert.deepEqual(requests.slice(before).filter((r) => r.path.startsWith(B + "/")), [], "nothing was sent for Bob's project");
    assert.ok(requests.slice(before).some((r) => r.path === A + "/journey-check" && r.authorization === "Bearer " + TOKENS.alice));
  });

  await t.test("an http, IP-literal or private live address is refused in plain words", async () => {
    for (const [liveUrl, pattern] of [["http://shop.example.com", /must start with https/], ["https://10.0.0.1", /numeric IP address/], ["https://printer.local", /private network/]]) {
      await assert.rejects(asAlice.mutation(ref("onboarding/projects:add"), { repoUrl: "https://github.com/alice/other", liveUrl }), (error) => pattern.test(message(error)), liveUrl);
    }
  });

  await t.test("the preparation refuses without the owner's coding agent, or without a linked installation, and starts no thread", async () => {
    const capyBefore = sent((r) => r.path.startsWith("/capy/")).length;
    await assert.rejects(asAlice.mutation(ref("onboarding/projects:approve"), { projectId: alice.appId, inspectionId: alice.inspectionId }), (error) => /^Connect a coding agent first/.test(message(error)));

    // Bob connects a coding agent, but his repository is not covered by an installation linked to him.
    await asBob.action(ref("secrets/account:setCodingAgentKey"), { apiKey: CAPY.bob });
    await asBob.mutation(ref("onboarding/projects:approve"), { projectId: bob.appId, inspectionId: bob.inspectionId });
    const [refused] = await until(async () => await admin.query(ref("secrets/localProof:snapshot"), { appIds: [bob.appId] }), ([p]) => p.preparation.blocked, "Bob's preparation was handed back");
    assert.equal(refused.preparation.approvedAt, undefined);
    assert.equal(refused.preparation.capyThreadId, undefined);
    assert.match(refused.preparation.blocked, /^turtl did not start the preparation: turtl's GitHub App is not installed on bob\/salon\..* Nothing was sent to the coding agent\.$/);
    assert.equal(sent((r) => r.path.startsWith("/capy/")).length, capyBefore, "nothing reached Capy");
  });

  await t.test("with its own coding agent and a linked installation, the preparation starts with the owner's key only", async () => {
    await asAlice.action(ref("secrets/account:setCodingAgentKey"), { apiKey: CAPY.alice });
    const consent = await asAlice.query(ref("consent/permission:status"), {});
    await asAlice.mutation(ref("consent/permission:allow"), { listVersion: consent.listVersion });
    await asAlice.mutation(ref("onboarding/projects:approve"), { projectId: alice.appId, inspectionId: alice.inspectionId });
    const [started] = await until(async () => await admin.query(ref("secrets/localProof:snapshot"), { appIds: [alice.appId] }), ([p]) => p.preparation.capyThreadId || p.preparation.openError || p.preparation.blocked, "Alice's preparation started");
    assert.ok(started.preparation.capyThreadId, JSON.stringify(started.preparation));
    // Following the thread afterwards (the per-minute cron) also uses Alice's key; the start is these two requests.
    const toCapy = sent((r) => r.path === "/capy/api/v1/projects" || r.path === "/capy/api/v1/threads");
    assert.deepEqual(toCapy.map((r) => [r.method, r.path, r.authorization]), [["GET", "/capy/api/v1/projects", "Bearer " + CAPY.alice], ["POST", "/capy/api/v1/threads", "Bearer " + CAPY.alice]]);
    assert.ok(sent((r) => r.path.startsWith("/capy/")).every((r) => r.authorization === "Bearer " + CAPY.alice));
    assert.match(JSON.parse(toCapy[1].body).message, /- "Customers can book and get a confirmation\."/);
    assert.equal(leaked(), false, "the deployment's Capy key never left");
  });

  await t.test("a 1,000-entry turtl.json registers at most 20 of each list, and Check again cannot be repeated at once", async () => {
    await admin.mutation(ref("secrets/localProof:markMerged"), { preparationId: alice.preparationId, sha: "merged-sha" });
    const before = requests.length;
    await asAlice.mutation(ref("onboarding/projects:checkAgain"), { projectId: alice.appId });
    const [registered] = await until(async () => await admin.query(ref("secrets/localProof:snapshot"), { appIds: [alice.appId] }), ([p]) => p.preparation.registration?.status === "done" && p.preparation.registration.checks.length, "registration finished", 60_000);
    const live = requests.slice(before).filter((r) => r.host === `127.0.0.1:${PORT}` && r.path.startsWith(A + "/"));
    assert.equal(live.filter((r) => r.path.startsWith(A + "/journey/")).length, 20);
    assert.equal(live.filter((r) => r.path.startsWith(A + "/flag/")).length, 20);
    assert.equal(registered.preparation.registration.checks.length, 41);
    assert.equal(registered.preparation.registration.note, "turtl.json lists 1000 journeys and 1000 flags. turtl checks only the first 20 of each list.");
    assert.ok(live.filter((r) => r.authorization).every((r) => r.authorization === "Bearer " + TOKENS.alice));
    await assert.rejects(asAlice.mutation(ref("onboarding/projects:checkAgain"), { projectId: alice.appId }), (error) => /less than 2 minutes ago/.test(message(error)));
  });

  await t.test("with AUTH_REQUIRED removed while the two owners' accounts exist, every call is refused in plain words, and the backend log says why", async () => {
    await convex("env", "remove", "AUTH_REQUIRED");
    await delay(1500);
    await assert.rejects(admin.action(ref("secrets/project:setControlToken"), { projectId: alice.appId, token: TOKENS.alice }), refused, "nobody is the single owner of these accounts' projects");
    await assert.rejects(asAlice.query(ref("secrets/project:controlToken"), { projectId: alice.appId }), refused, "nor is an owner served as the demo");
    await assert.rejects(admin.query(ref("screens/projects:list"), {}), refused);
    // What the operator sees: the monitor's cron writes one line to the backend log when it first finds the demo
    // closed, and checks nothing (convex/access.ts, noteClosedDemo; review finding 20).
    const first = await admin.mutation(ref("access:noteClosedDemo"), {});
    const again = await admin.mutation(ref("access:noteClosedDemo"), {});
    assert.ok(first.closed && first.loggedAt !== null && again.loggedAt === first.loggedAt, "the line was written once, not once a call");
    const tick = await admin.action(ref("monitor:tick"), {});
    assert.match(tick.skipped ?? "", /holds accounts but runs as the single-owner demo, so the monitor checked nothing/);
    const sentBefore = requests.length;
    await delay(1500);
    assert.equal(requests.length, sentBefore, "nothing more reached the owners' apps");
  });
});
