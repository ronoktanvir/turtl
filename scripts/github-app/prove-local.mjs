#!/usr/bin/env node
// Runs convex/github on a local Convex backend against the stand-in GitHub in stub.mjs, so the JWT is signed, the
// webhook is verified, Connect GitHub's two pages answer over HTTP, and the tables are written by Convex's own
// runtime. Nothing here talks to GitHub.
//   CONVEX_AGENT_MODE=anonymous npx convex dev     (one terminal; keep it running)
//   node scripts/github-app/prove-local.mjs        (another; --port <n> serves the stand-in on that port)
// It refuses to run unless .env.local names a local backend, and it removes the variables it set when it ends.
// Accounts stay off here (no sign-in exists on a local backend), so Connect GitHub files under the single owner;
// tests/github-connect.test.mjs proves the same flow with accounts on.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browse, startGithubStub } from "./stub.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const local = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z_]+)=(\S+)/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const convexUrl = local.EXPO_PUBLIC_CONVEX_URL ?? "";
const siteUrl = local.EXPO_PUBLIC_CONVEX_SITE_URL ?? "";
const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
if (!/^(anonymous|local):/.test(local.CONVEX_DEPLOYMENT ?? "") || !isLocal(convexUrl) || !isLocal(siteUrl)) {
  console.error("Refusing to run: .env.local does not name a local Convex backend. Start one with CONVEX_AGENT_MODE=anonymous npx convex dev.");
  process.exit(1);
}

const VARIABLES = ["GITHUB_API_URL", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"];
// The stub is served by this process, so the Convex CLI must never block it: every call is asynchronous.
const convex = async (...args) => (await promisify(execFile)("npx", ["convex", ...args], { cwd: root, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } })).stdout;
// The CLI prints nothing for a function that returns null.
const run = async (name, args = {}) => JSON.parse((await convex("run", name, JSON.stringify(args))).trim() || "null");
const clearVariables = async () => {
  for (const name of VARIABLES) await convex("env", "remove", name).catch(() => {});
};

const id = (Date.now() % 1_000_000_000) + 1_000_000;
const owner = "octo-" + id.toString(36);
const appId = "424242";
const secret = randomBytes(24).toString("hex");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const manifest = JSON.parse(readFileSync(join(root, "convex/github/app-manifest.json"), "utf8"));
const portIndex = process.argv.indexOf("--port");
const stub = await startGithubStub({
  appId,
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
  permissions: manifest.default_permissions,
  events: manifest.default_events,
  site: siteUrl,
  port: portIndex === -1 ? 0 : Number(process.argv[portIndex + 1]),
});
const scratch = mkdtempSync(join(tmpdir(), "turtl-github-app-"));

const installation = (suspended = false) => ({ id, account: { login: owner, type: "User" }, repository_selection: "selected", suspended_at: suspended ? new Date().toISOString() : null });
const repository = (name, index) => ({ id: id * 10 + index, name, full_name: owner + "/" + name, private: true });
const deliver = async (event, payload, { deliveryId = randomUUID(), signWith = secret } = {}) => {
  const body = JSON.stringify(payload);
  const response = await fetch(siteUrl + "/github/webhook", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": deliveryId, "X-Hub-Signature-256": "sha256=" + createHmac("sha256", signWith).update(body).digest("hex") },
  });
  return { status: response.status, ...(await response.json()) };
};
const names = async () => (await run("github/installations:repositories", { installationId: id })).map((entry) => entry.fullName);
const mints = () => stub.requests.filter((request) => request.method === "POST" && request.path.endsWith("/access_tokens")).length;

let passed = 0;
const step = async (name, body) => {
  await body();
  passed += 1;
  console.log("ok   " + name);
};

try {
  await clearVariables();
  await step("with no GitHub App variables, a repository gets the deployment credential (the fallback)", async () => {
    const report = await run("github/access:check", { repo: owner + "/app" });
    assert.equal(report.app, "absent");
    assert.equal(report.github, null);
    assert.equal(report.repository.source, "deployment");
    assert.equal(stub.requests.length, 0);
  });

  const keyFile = join(scratch, "app.private-key.pem");
  writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs1", format: "pem" }));
  await convex("env", "set", "GITHUB_API_URL", stub.url);
  await convex("env", "set", "GITHUB_APP_ID", appId);
  await convex("env", "set", "GITHUB_APP_SLUG", "turtl-on-call");
  await convex("env", "set", "GITHUB_APP_WEBHOOK_SECRET", secret);
  await convex("env", "set", "GITHUB_APP_PRIVATE_KEY", "--from-file", keyFile);

  await step("Convex signs the app JWT from a PKCS#1 key set with --from-file, and the stub verifies it with the public key", async () => {
    const report = await run("github/access:check");
    assert.equal(report.app, "ready");
    assert.deepEqual(report.github, { ok: true, slug: "turtl-on-call", slugMatches: true, permissions: manifest.default_permissions, permissionsMatch: true, events: [] });
    const request = stub.requests.at(-1);
    assert.equal(request.credential, "app");
    assert.deepEqual(request.jwt.header, { alg: "RS256", typ: "JWT" });
    assert.equal(request.jwt.claims.iss, appId);
    assert.equal(request.jwt.claims.exp - request.jwt.claims.iat, 600);
  });

  const createdPayload = { action: "created", installation: installation(), repositories: [repository("app", 1), repository("site", 2)], sender: { login: owner } };
  await step("a webhook with a wrong signature is refused with 401 and records nothing", async () => {
    const refused = await deliver("installation", createdPayload, { signWith: "not-the-secret" });
    assert.equal(refused.status, 401);
    assert.equal(refused.error.code, "INVALID_SIGNATURE");
    assert.deepEqual(await names(), []);
  });
  await step("a signed installation.created records the installation and its repositories", async () => {
    assert.deepEqual(await deliver("installation", createdPayload, { deliveryId: "created-" + id }), { status: 200, ok: true, outcome: "applied" });
    assert.deepEqual(await names(), [owner + "/app", owner + "/site"]);
  });
  await step("a replay changes nothing, by delivery id or by signed body", async () => {
    assert.equal((await deliver("installation", createdPayload, { deliveryId: "created-" + id })).outcome, "duplicate");
    assert.equal((await deliver("installation", createdPayload)).outcome, "duplicate");
  });

  stub.install({ id, login: owner, repositories: [owner + "/app", owner + "/site", owner + "/unannounced"] });
  await step("a covered repository gets an installation token, minted once and then served from the cache", async () => {
    const first = await run("github/access:check", { repo: owner + "/app" });
    assert.deepEqual(first.repository, { ok: true, source: "installation", installationId: id });
    assert.equal(mints(), 1);
    assert.deepEqual((await run("github/access:check", { repo: owner.toUpperCase() + "/SITE" })).repository, { ok: true, source: "installation", installationId: id });
    assert.equal(mints(), 1);
    assert.equal(JSON.stringify(first).includes("ghs_stub_"), false);
  });
  await step("a repository no installation covers is refused, and the deployment credential is not used", async () => {
    const report = await run("github/access:check", { repo: owner + "/private-notes" });
    assert.equal(report.repository.ok, false);
    assert.equal(report.repository.reason, "not_installed");
  });
  await step("a repository GitHub covers but no webhook announced is found by asking GitHub", async () => {
    assert.deepEqual((await run("github/access:check", { repo: owner + "/unannounced" })).repository, { ok: true, source: "installation", installationId: id });
    assert.equal((await names()).includes(owner + "/unannounced"), true);
  });
  await step("the token cannot be read through the public API", async () => {
    for (const path of ["github/tokens:cached", "github/installations:repositories"]) {
      const response = await fetch(convexUrl + "/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, args: { installationId: id }, format: "json" }) });
      const text = await response.text();
      assert.equal(text.includes("ghs_stub_"), false);
      assert.match(text, /Could not find public function/, path + " answered a public caller");
    }
  });

  const many = Array.from({ length: 230 }, (_, index) => owner + "/repo-" + String(index).padStart(3, "0"));
  stub.install({ id, login: owner, selection: "all", repositories: [owner + "/app", ...many] });
  await step("listing reads every page from GitHub and makes the records match", async () => {
    const listed = await run("github/sync:refresh", { installationId: id });
    assert.equal(listed.ok, true);
    assert.equal(listed.repositories.length, 231);
    assert.deepEqual(await names(), listed.repositories.map((entry) => entry.fullName));
    assert.equal((await names()).includes(owner + "/site"), false);
    assert.equal(stub.requests.filter((request) => request.path === "/installation/repositories" && request.credential === "installation").length, 3);
  });

  await step("repositories removed, then the installation suspended, unsuspended and deleted", async () => {
    stub.install({ id, login: owner, repositories: [owner + "/app"] });
    const removed = { action: "removed", installation: installation(), repository_selection: "selected", repositories_added: [], repositories_removed: [repository("repo-000", 3)], sender: { login: owner } };
    assert.equal((await deliver("installation_repositories", removed)).outcome, "applied");
    assert.equal((await names()).includes(owner + "/repo-000"), false);

    stub.install({ id, login: owner, suspended: true, repositories: [owner + "/app"] });
    assert.equal((await deliver("installation", { action: "suspend", installation: installation(true), sender: { login: owner } })).outcome, "applied");
    assert.equal((await run("github/access:check", { repo: owner + "/app" })).repository.reason, "suspended");
    assert.deepEqual(await names(), []);

    stub.install({ id, login: owner, repositories: [owner + "/app"] });
    assert.equal((await deliver("installation", { action: "unsuspend", installation: installation(), repositories: [repository("app", 1)], sender: { login: owner } })).outcome, "applied");
    assert.equal((await run("github/access:check", { repo: owner + "/app" })).repository.source, "installation");

    stub.installations.delete(id);
    assert.equal((await deliver("installation", { action: "deleted", installation: installation(), sender: { login: owner } })).outcome, "applied");
    assert.equal((await run("github/access:check", { repo: owner + "/app" })).repository.reason, "not_installed");
    assert.deepEqual(await names(), []);
  });

  await step("the setup address answers, and reads nothing from the installation id it is given", async () => {
    const response = await fetch(siteUrl + "/github/setup?installation_id=" + id + "&setup_action=install");
    assert.equal(response.status, 200);
    assert.deepEqual(await names(), []);
  });

  // Connect GitHub on the same backend: turtl's two pages answer over HTTP, the app's functions are called through
  // the CLI the way the app calls them, and the stand-in plays the person's browser on github.com.
  await convex("env", "set", "AUTH_GITHUB_ID", stub.clientId);
  await convex("env", "set", "AUTH_GITHUB_SECRET", stub.clientSecret);
  const connectId = id + 1;
  let ticket = "";
  let callback = "";
  await step("Connect GitHub: the install page, turtl's setup page, GitHub's authorize page and turtl's callback bring the person back with a ticket", async () => {
    const status = await run("github/connect:status");
    assert.deepEqual([status.configured, status.accounts, status.connections], [true, false, []]);
    stub.signIn(owner);
    stub.willInstall({ id: connectId, repositories: [owner + "/app", owner + "/site"] });
    const { url } = await run("github/connect:begin", { returnTo: "app" });
    assert.ok(url.startsWith(stub.url + "/apps/turtl-on-call/installations/new?state="), url);
    const landed = await browse(url);
    assert.deepEqual(landed.visited.map((address) => new URL(address).pathname), ["/apps/turtl-on-call/installations/new", "/github/setup", "/login/oauth/authorize", "/github/callback"]);
    const back = new URL(landed.url);
    assert.equal(back.href.split("?")[0], "turtl://add-project");
    assert.equal(back.searchParams.get("github"), "connected");
    ticket = back.searchParams.get("ticket");
    callback = landed.visited[3];
    assert.equal(stub.revoked.length, 1, "the person's user token was revoked");
  });
  await step("the callback cannot be replayed", async () => {
    assert.equal((await fetch(callback, { redirect: "manual" })).status, 400);
  });
  await step("finishing files the installation under the single owner; the picker lists its repositories, with no token over the public API", async () => {
    assert.deepEqual(await run("github/connect:finish", { ticket }), { connected: 1, githubLogin: owner });
    await assert.rejects(run("github/connect:finish", { ticket }), /expired or was started on another sign-in/);
    assert.deepEqual((await run("github/connect:status")).connections.map((connection) => connection.installationId), [connectId]);
    assert.deepEqual(await run("github/connect:refresh"), { ok: true, problems: [] });
    assert.deepEqual((await run("github/connect:repositories")).map((repository) => repository.fullName), [owner + "/app", owner + "/site"]);
    assert.deepEqual((await run("github/access:check", { repo: owner + "/app" })).repository, { ok: true, source: "installation", installationId: connectId });
    for (const path of ["github/connect:status", "github/connect:repositories"]) {
      const text = await (await fetch(convexUrl + "/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, args: {}, format: "json" }) })).text();
      assert.match(text, /"status":"success"/, path);
      assert.equal(/gh[su]_stub_/.test(text), false, path);
    }
  });
  await step("a forged installation id connects nothing", async () => {
    stub.signIn("someone-else-" + id);
    const { url } = await run("github/connect:begin", { returnTo: "app" });
    const state = new URL(url).searchParams.get("state");
    const landed = await browse(siteUrl + "/github/setup?installation_id=" + connectId + "&setup_action=install&state=" + state);
    assert.equal(new URL(landed.url).searchParams.get("github"), "none");
    assert.deepEqual((await run("github/connect:status")).connections.map((connection) => connection.installationId), [connectId]);
  });
  await step("disconnecting needs the owner passcode in the demo; account deletion's disconnect uninstalls at GitHub and leaves no token or link", async () => {
    if (!(await run("ownerPasscode:status")).configured) {
      await assert.rejects(run("github/connect:disconnect"), /Set an owner passcode in project settings before disconnecting GitHub/);
    }
    assert.deepEqual(await run("github/connect:disconnectAccount", { account: "solo-owner" }), { ok: true, disconnected: 1, failed: [] });
    assert.deepEqual(stub.uninstalled, [connectId]);
    assert.equal(await run("github/tokens:cached", { installationId: connectId }), null);
    assert.deepEqual(await run("github/links:installationsOf", { account: "solo-owner" }), []);
    assert.deepEqual((await run("github/connect:status")).connections, []);
    assert.equal((await run("github/access:check", { repo: owner + "/app" })).repository.reason, "not_installed");
  });

  await clearVariables();
  await step("with the variables removed again, the fallback is back", async () => {
    assert.equal((await run("github/access:check", { repo: owner + "/app" })).repository.source, "deployment");
  });
  console.log("\n" + passed + " steps passed on " + convexUrl + " against the stub at " + stub.url + ". Nothing ran against GitHub.");
} finally {
  await clearVariables();
  rmSync(scratch, { recursive: true, force: true });
  await stub.close();
}
