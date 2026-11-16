#!/usr/bin/env node
// Proves practice projects (convex/practice) on a local Convex backend with accounts on. Convex's own runtime runs the
// functions, the scheduler, the cron that watches every project, Web Crypto and the HTTP routes; turtl reaches each
// practice app over HTTP at this deployment's own site address, through call(), with that project's own token. No
// model key and no vendor is configured: the cases run on turtl's rules, as they do without the AI permission.
//   CONVEX_AGENT_MODE=anonymous npx convex dev --typecheck disable --local-cloud-port 3270 --local-site-port 3271   (keep it running)
//   node scripts/practice/prove-local.mjs
// It refuses to run unless .env.local names a local backend, and removes every variable it set when it ends.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const root = fileURLToPath(new URL("../../", import.meta.url));
const local = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z_]+)=(\S+)/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const convexUrl = local.EXPO_PUBLIC_CONVEX_URL ?? local.CONVEX_URL ?? "";
const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
if (!/^(anonymous|local):/.test(local.CONVEX_DEPLOYMENT ?? "") || !isLocal(convexUrl)) {
  console.error("Refusing to run: .env.local does not name a local Convex backend. Start one with CONVEX_AGENT_MODE=anonymous npx convex dev.");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(root, ".convex/local/default/config.json"), "utf8"));
const site = `http://127.0.0.1:${config.ports.site}`;
const admin = new ConvexHttpClient(convexUrl);
admin.setAdminAuth(config.adminKey);

const scratch = mkdtempSync(join(tmpdir(), "turtl-practice-proof-"));
const convex = async (...args) => (await promisify(execFile)("npx", ["convex", ...args], { cwd: root, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } })).stdout;
const run = async (name, args = {}) => JSON.parse((await convex("run", name, JSON.stringify(args))).trim() || "null");
const signing = await generateKeyPair("RS256", { extractable: true });
const fromFile = {
  JWT_PRIVATE_KEY: (await exportPKCS8(signing.privateKey)).trimEnd().replace(/\n/g, " "),
  JWKS: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(signing.publicKey)) }] }),
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
const plain = {
  AUTH_REQUIRED: "true",
  SITE_URL: "http://localhost:8111",
  // This backend's site address is http://127.0.0.1, which only a local backend may watch, and only with this.
  WATCHED_APP_ALLOW_LOOPBACK: "true",
  // Opens convex/practice/localProof.ts on this localhost backend; with accounts on the dev tools stay closed.
  DEV_TOOLS_ENABLED: "true",
  PRACTICE_BREAKS_PER_DAY: "2",
};
const VARIABLES = [...Object.keys(fromFile), ...Object.keys(plain)];
const cleanUp = async () => {
  for (const name of VARIABLES) await convex("env", "remove", name).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, ok, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (ok(value)) return value;
    await sleep(1000);
  }
  throw new Error(`${label}: ${JSON.stringify(value)?.slice(0, 1500)}`);
}
const message = (error) => String(error?.data ?? error?.message ?? error);
let passed = 0;
const step = async (name, body) => {
  const started = Date.now();
  await body();
  passed += 1;
  console.log(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};
const note = (...lines) => lines.forEach((line) => console.log("     " + line));

const fn = {
  status: ref("practice/projects:status"),
  create: ref("practice/projects:create"),
  breakApp: ref("practice/projects:breakApp"),
  mend: ref("practice/projects:mend"),
  list: ref("screens/projects:list"),
  cards: ref("cases:cards"),
  forCase: ref("fixes:forCase"),
  approve: ref("decisions:approve"),
  decline: ref("decisions:decline"),
  allowAi: ref("consent/permission:allow"),
  aiStatus: ref("consent/permission:status"),
};
const snapshot = async (appIds) => await admin.query(ref("practice/localProof:snapshot"), { appIds });
const secretsOf = async (appIds) => (await admin.query(ref("secrets/localProof:snapshot"), { appIds })).map((project) => project.secrets);
const demoSwitches = async () => await run("bookingDemo/state:read");
const caseOf = async (who, caseId) => await who.client.query(fn.cards, { id: caseId });
const finishedStatuses = ["restored", "resolved"];

try {
  for (const [name, value] of Object.entries(fromFile)) {
    const file = join(scratch, name);
    writeFileSync(file, value, { mode: 0o600 });
    await convex("env", "set", name, "--from-file", file);
  }
  for (const [name, value] of Object.entries(plain)) await convex("env", "set", name, value);
  await sleep(1500);

  const signUp = async (label) => {
    const email = `${label}-${randomBytes(3).toString("hex")}@example.com`;
    const client = new ConvexHttpClient(convexUrl);
    const { tokens } = await client.action(ref("auth:signIn"), { provider: "password", params: { email, password: "local proof " + randomBytes(12).toString("hex"), flow: "signUp" } });
    client.setAuth(tokens.token);
    const [user] = JSON.parse(Buffer.from(tokens.token.split(".")[1], "base64url").toString()).sub.split("|");
    return { label, email, client, user };
  };
  const alice = await signUp("alice");
  const bob = await signUp("bob");
  const demoBefore = await demoSwitches();

  await step("a new account can have a practice app, and has none yet", async () => {
    for (const who of [alice, bob]) {
      const status = await who.client.query(fn.status, {});
      assert.deepEqual(status, { available: true, breaksPerDay: 2, project: null });
    }
  });

  await step("Create makes one practice project per account; asking twice returns the same one", async () => {
    alice.projectId = (await alice.client.action(fn.create, {})).projectId;
    assert.equal((await alice.client.action(fn.create, {})).projectId, alice.projectId);
    bob.projectId = (await bob.client.action(fn.create, {})).projectId;
    assert.notEqual(bob.projectId, alice.projectId);
    const [a, b] = await snapshot([alice.projectId, bob.projectId]);
    for (const project of [a, b]) {
      assert.equal(project.app.name, "Practice booking app");
      assert.equal(project.app.practice, true);
      assert.equal(project.app.repoUrl, null, "a practice project has no repository");
      assert.ok(project.app.productionUrl.startsWith(`${site}/practice/`));
      assert.deepEqual(project.catalog.map((entry) => entry.kind), ["http", "http"], "two switches and no pull request action");
      assert.deepEqual(project.practice, { recommendationsEnabled: true, providerTimeout: false, bookingStoreFailure: false, backupStoreEnabled: false, broken: null, breaks: null, tokenHashLength: 64 });
    }
    assert.deepEqual(await secretsOf([alice.projectId, bob.projectId]), [1, 1], "each project's own control token, sealed");
    const projects = await alice.client.query(fn.list, {});
    assert.deepEqual(projects.map((p) => p.app._id), [alice.projectId], "Alice sees her practice project and nothing of Bob's");
    note(`alice: ${a.app.productionUrl}`, `bob:   ${b.app.productionUrl}`);
  });

  await step("each practice app answers only to its own token; a path naming no practice app is 404", async () => {
    const at = (projectId, path) => `${site}/practice/${projectId}${path}`;
    const status = async (url, init) => (await fetch(url, init)).status;
    assert.equal(await status(at(alice.projectId, "/health")), 200);
    assert.equal(await status(at(alice.projectId, "/revision")), 200);
    assert.equal(await status(at(alice.projectId, "/flags")), 401);
    assert.equal(await status(at(alice.projectId, "/flags"), { headers: { Authorization: "Bearer " + randomBytes(32).toString("hex") } }), 401);
    assert.equal(await status(at(alice.projectId, "/journey-check"), { method: "POST" }), 401);
    assert.equal(await status(at(alice.projectId, "/flags"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recommendationsEnabled: false }) }), 401);
    assert.equal(await status(at(alice.projectId, "/staged-failure"), { method: "POST" }), 404, "no route breaks a practice app");
    assert.equal(await status(at("not-a-project", "/health")), 404);
  });

  await step("the monitor's ordinary watching checks both practice apps with their own tokens, and both pass", async () => {
    const [a, b] = await until(() => snapshot([alice.projectId, bob.projectId]), (both) => both.every((p) => p.journeys[0]?.lastPassedAt), "waiting for the cron's checks", 150_000);
    note(`alice passed at ${new Date(a.journeys[0].lastPassedAt).toISOString()}, bob at ${new Date(b.journeys[0].lastPassedAt).toISOString()}`);
  });

  const bobBefore = (await snapshot([bob.projectId]))[0];

  const breakAndOpen = async (who, failure) => {
    const brokenAt = Date.now();
    const result = await who.client.mutation(fn.breakApp, { projectId: who.projectId, failure });
    const status = await until(() => who.client.query(fn.status, {}), (s) => s.project?.caseId, `waiting for ${who.label}'s case`);
    assert.equal(status.project.failure, failure);
    return { caseId: status.project.caseId, breaksLeft: result.breaksLeft, brokenAt };
  };
  const waitingCase = async (who, caseId) =>
    await until(() => caseOf(who, caseId), (cards) => cards?.case.status === "waiting_for_owner", `waiting for ${who.label}'s case to need a decision`);
  const approveAndRestore = async (who, caseId, optionKey) => {
    const fixes = await who.client.query(fn.forCase, { caseId });
    await who.client.mutation(fn.approve, { proposalId: fixes.proposalId, version: fixes.version, optionKey });
    return await until(() => caseOf(who, caseId), (cards) => finishedStatuses.includes(cards?.case.status), `waiting for ${who.label}'s fix to be checked`);
  };

  let first;
  await step("Alice breaks hers (recommendations time out): turtl notices and opens a case on her practice project only", async () => {
    first = await breakAndOpen(alice, "recommendations");
    assert.equal(first.breaksLeft, 1);
    const cards = await caseOf(alice, first.caseId);
    assert.equal(cards.case.raisedBy, "monitor");
    assert.equal(cards.case.appId, alice.projectId);
    assert.equal((await bob.client.query(fn.status, {})).project.caseId, undefined);
    assert.equal(await bob.client.query(fn.cards, { id: first.caseId }), null, "Bob cannot read Alice's case");
    const [b] = await snapshot([bob.projectId]);
    assert.deepEqual(b.practice, bobBefore.practice, "Bob's practice app is untouched");
    assert.deepEqual(b.cases, []);
    assert.deepEqual(await demoSwitches(), demoBefore, "the single-owner demo's booking app is untouched");
    note(`case "${cards.case.title}" opened ${((cards.case._creationTime - first.brokenAt) / 1000).toFixed(1)} s after the break`);
  });

  await step("with no AI permission, the ordinary flow runs on turtl's rules to a fix waiting for Alice", async () => {
    const cards = await waitingCase(alice, first.caseId);
    const investigate = cards.steps.find((s) => s.purpose === "investigate");
    note(`investigate: ${investigate.currentAttempt.summary.slice(0, 220)}`);
    const fixes = await alice.client.query(fn.forCase, { caseId: first.caseId });
    assert.deepEqual(fixes.fixes.map((f) => [f.key, f.title, f.recommended, f.delivery]), [["turn_off_recommendations", "Turn off recommendations", true, "action"]], "only the catalog switch, no code change");
    assert.ok(!cards.proposal.doneMeans.some((c) => c.id === "booking_screen_on_device"), "no device run for a practice app");
    await assert.rejects(bob.client.mutation(fn.approve, { proposalId: fixes.proposalId, version: fixes.version, optionKey: "turn_off_recommendations" }), /Proposal not found/, "Bob cannot approve Alice's fix");
  });

  await step("Alice approves: turtl turns recommendations off on her practice app and the booking check passes again", async () => {
    const cards = await approveAndRestore(alice, first.caseId, "turn_off_recommendations");
    const after = cards.verifications.find((v) => v.phase === "after_fix");
    assert.equal(after.verdict, "passed");
    assert.equal(cards.action.status, "completed");
    note(`action: ${cards.action.result}`, `verify: ${after.summary}`);
    const [a] = await snapshot([alice.projectId]);
    assert.equal(a.practice.recommendationsEnabled, false);
    assert.ok(a.journeys[0].lastPassedAt > first.brokenAt, "the journey passed after the fix");
    assert.equal(a.bookings, 0, "every test booking was deleted");
    const status = await alice.client.query(fn.status, {});
    assert.equal(status.project.failure, null);
    assert.equal(status.project.note, "Recommendations are off since turtl's last fix.");
  });

  let second;
  await step("Alice breaks it a second time (bookings fail to save): a new case offers the backup store, and it works", async () => {
    second = await breakAndOpen(alice, "booking_store");
    assert.notEqual(second.caseId, first.caseId);
    assert.equal(second.breaksLeft, 0);
    await waitingCase(alice, second.caseId);
    const fixes = await alice.client.query(fn.forCase, { caseId: second.caseId });
    assert.deepEqual(fixes.fixes.map((f) => [f.key, f.recommended, f.delivery]), [["use_backup_store", true, "action"]]);
    const cards = await approveAndRestore(alice, second.caseId, "use_backup_store");
    const after = cards.verifications.find((v) => v.phase === "after_fix");
    assert.equal(after.verdict, "passed");
    note(`action: ${cards.action.result}`, `verify: ${after.summary}`);
    const [a] = await snapshot([alice.projectId]);
    assert.equal(a.practice.backupStoreEnabled, true);
    assert.equal(a.cases.length, 2);
    assert.ok(a.cases.every((c) => finishedStatuses.includes(c.status)), JSON.stringify(a.cases));
  });

  await step("the daily limit refuses a third break, in plain words", async () => {
    await assert.rejects(alice.client.mutation(fn.breakApp, { projectId: alice.projectId, failure: "recommendations" }), /You have broken your practice app 2 times today, the most for one day\. You can break it again tomorrow\./);
    const [a] = await snapshot([alice.projectId]);
    assert.equal(a.practice.breaks.count, 2);
  });

  await step("Bob allows AI (no model key here): his case still reaches a decision; he declines, puts it back, and it passes", async () => {
    await bob.client.mutation(fn.allowAi, { listVersion: (await bob.client.query(fn.aiStatus, {})).listVersion });
    const bobCase = await breakAndOpen(bob, "booking_store");
    await assert.rejects(bob.client.mutation(fn.breakApp, { projectId: bob.projectId, failure: "recommendations" }), /already broken|already working on an issue/);
    await assert.rejects(bob.client.mutation(fn.mend, { projectId: bob.projectId }), /Decline its fixes under Fix first/);
    const cards = await waitingCase(bob, bobCase.caseId);
    const investigate = cards.steps.find((s) => s.purpose === "investigate");
    note(`investigate: ${investigate.currentAttempt.summary.slice(0, 220)}`);
    const fixes = await bob.client.query(fn.forCase, { caseId: bobCase.caseId });
    await bob.client.mutation(fn.decline, { proposalId: fixes.proposalId, version: fixes.version });
    assert.equal((await caseOf(bob, bobCase.caseId)).case.status, "declined");
    assert.equal((await bob.client.query(fn.status, {})).project.failure, "booking_store", "declining changes nothing in the app");
    await bob.client.mutation(fn.mend, { projectId: bob.projectId });
    const [b] = await until(() => snapshot([bob.projectId]), ([p]) => p.journeys[0].lastPassedAt > bobCase.brokenAt, "waiting for Bob's put-back to pass");
    assert.equal(b.practice.bookingStoreFailure, false);
    const [a] = await snapshot([alice.projectId]);
    assert.equal(a.cases.length, 2, "nothing of Bob's reached Alice");
  });

  let carol;
  await step("the operator's practice/review:prepare leaves the review account with an open case", async () => {
    carol = await signUp("review");
    const prepared = await run("practice/review:prepare", { email: carol.email });
    assert.equal(prepared.created, true);
    carol.projectId = prepared.projectId;
    const status = await carol.client.query(fn.status, {});
    assert.equal(status.project.caseId, prepared.caseId);
    assert.equal(status.project.breaksLeft, 2, "the operator's break does not count against the reviewer");
    const again = await run("practice/review:prepare", { email: carol.email });
    assert.deepEqual(again, { ...prepared, created: false }, "running it again changes nothing");
    const cards = await waitingCase(carol, prepared.caseId);
    note(`review account's case: "${cards.case.title}", ${cards.case.status}`);
  });

  await step("deleting Alice's account removes her practice project and its rows; Bob's stay as they were", async () => {
    const bobKept = async () => {
      const [b] = await snapshot([bob.projectId]);
      return { app: b.app, practice: b.practice, catalog: b.catalog, cases: b.cases.map((c) => c.id), secrets: await secretsOf([bob.projectId]) };
    };
    const before = await bobKept();
    await alice.client.mutation(ref("account/deletion:request"), {});
    await until(async () => {
      const record = await run("account/deletion:lookup", { account: alice.user });
      if (record?.stage === "settle" || record?.stage === "waiting") await run("account/deletion:hurry", { account: alice.user });
      return record;
    }, (record) => record?.status === "done", "waiting for Alice's deletion");
    const [a] = await snapshot([alice.projectId]);
    assert.deepEqual({ app: a.app, practice: a.practice, bookings: a.bookings, journeys: a.journeys, catalog: a.catalog, cases: a.cases }, { app: null, practice: null, bookings: 0, journeys: [], catalog: [], cases: [] });
    assert.deepEqual(await secretsOf([alice.projectId]), [0]);
    assert.equal((await fetch(`${site}/practice/${alice.projectId}/health`)).status, 404, "her practice app no longer answers");
    assert.deepEqual(await bobKept(), before);
    assert.deepEqual(await demoSwitches(), demoBefore);
  });

  await step("with AUTH_REQUIRED unset (the single-owner demo) there is no practice app to offer or make", async () => {
    await convex("env", "remove", "AUTH_REQUIRED");
    await sleep(1500);
    assert.deepEqual(await admin.query(fn.status, {}), { available: false, breaksPerDay: 2, project: null });
    await assert.rejects(admin.action(fn.create, {}), /A practice app needs accounts/);
  });

  console.log(`\n${passed} checks passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanUp();
}
