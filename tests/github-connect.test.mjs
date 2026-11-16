import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { APP_ID, connectWorld, LEGACY_TOKEN, lifecycle, MINUTE, PKCS1, SITE, SOLO, START, WEBHOOK_SECRET, world } from "./github-harness.mjs";

// Connect GitHub (convex/github/connect.ts and the two pages in convex/github/http.ts) against the stand-in GitHub in
// scripts/github-app/stub.mjs. The person's browser is played by browse(): GitHub's install and authorize pages come
// from the stub, turtl's /github/setup and /github/callback from the real HTTP actions. The app's calls go through
// backend.call as a signed-in account (accounts on) or as nobody (the single-owner demo, where everyone is
// "solo-owner"). Nothing here talks to GitHub.

const EXPIRED = /expired or was started on another sign-in/;

test("Connect GitHub binds an installation to the account that started, once GitHub confirms who came back", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  const alice = await w.project("alice-account");
  assert.deepEqual(await w.status("alice-account"), { configured: true, accounts: true, signedIn: true, connections: [] });

  const url = await w.begin("alice-account", "alice", { id: 7101, repositories: ["alice/app", "alice/site"] });
  const install = new URL(url);
  assert.equal(install.origin + install.pathname, w.stub.url + "/apps/turtl-on-call/installations/new");
  const state = install.searchParams.get("state");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/, "32 random bytes");
  const landed = await w.open(url);
  assert.deepEqual(landed.visited.map((address) => new URL(address).pathname), ["/apps/turtl-on-call/installations/new", "/github/setup", "/login/oauth/authorize", "/github/callback"]);
  assert.equal(new URL(landed.visited[1]).searchParams.get("installation_id"), "7101", "GitHub names the installation, and turtl does not take its word for it");
  const authorize = new URL(landed.visited[2]).searchParams;
  assert.deepEqual([authorize.get("client_id"), authorize.get("redirect_uri"), authorize.get("state"), authorize.get("code_challenge_method")], [w.stub.clientId, SITE + "/github/callback", state, "S256"]);
  assert.equal(landed.url.split("?")[0], "turtl://add-project");
  const back = new URL(landed.url);
  assert.equal(back.searchParams.get("github"), "connected");
  const ticket = back.searchParams.get("ticket");
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);

  // GitHub confirmed alice, but nothing is usable until the account that started finishes in the app.
  assert.deepEqual((await w.status("alice-account")).connections, []);
  assert.equal((await w.access("alice/app", { appId: alice.appId })).reason, "not_connected");

  assert.deepEqual(await w.backend.call("github.connect.finish", { ticket }, "alice-account"), { connected: 1, githubLogin: "alice" });
  assert.deepEqual((await w.status("alice-account")).connections, [
    { installationId: 7101, accountLogin: "alice", githubLogin: "alice", status: "active", scope: "all", settingsUrl: w.stub.url + "/settings/installations/7101" },
  ]);
  assert.deepEqual(await w.backend.call("github.connect.repositories", {}, "alice-account"), [
    { fullName: "alice/app", private: true, installationId: 7101, accountLogin: "alice" },
    { fullName: "alice/site", private: true, installationId: 7101, accountLogin: "alice" },
  ]);
  const access = await w.access("alice/app", { appId: alice.appId });
  assert.deepEqual([access.ok, access.source, access.installationId], [true, "installation", 7101]);
  assert.equal((await w.access("alice/site", { caseId: alice.caseId })).installationId, 7101, "a case reaches its project's owner too");

  // The person's user token answered GitHub's three questions and was revoked; turtl stored no token, state or ticket.
  assert.deepEqual(
    w.stub.requests.filter((request) => request.credential === "user").map((request) => request.path),
    ["/user", "/user/installations", "/user/installations/7101/repositories"],
  );
  assert.deepEqual(w.stub.revoked, ["ghu_stub_1"]);
  assert.equal(w.stub.userTokens.size, 0);
  const stored = w.backend.snapshot();
  for (const secret of ["ghu_stub_", state, ticket]) assert.equal(stored.includes(secret), false, "the records hold no " + secret.slice(0, 8));
  assert.deepEqual(w.backend.rows("githubConnectAttempts").map(({ status, codeVerifier }) => ({ status, codeVerifier })), [{ status: "finished", codeVerifier: "" }]);
  for (const answer of [await w.status("alice-account"), await w.backend.call("github.connect.repositories", {}, "alice-account")]) {
    assert.equal(/gh[su]_stub_/.test(JSON.stringify(answer)), false);
  }

  await assert.rejects(w.backend.call("github.connect.finish", { ticket }, "alice-account"), EXPIRED, "a ticket works once");
  // Signed out, none of it is reachable.
  await assert.rejects(w.backend.call("github.connect.begin", { returnTo: "app" }, null), /Sign in to continue/);
  await assert.rejects(w.backend.call("github.connect.finish", { ticket }, null), /Sign in to continue/);
  await assert.rejects(w.backend.call("github.connect.disconnect", {}, null), /Sign in to continue/);
  assert.deepEqual(await w.status(null), { configured: true, accounts: true, signedIn: false, connections: [] });
  assert.deepEqual(await w.pickable(null), []);
});

test("someone whose installation already exists can start at GitHub's authorize page and skip the install page", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  const alice = await w.project("alice-account");
  w.stub.install({ id: 7101, login: "alice", repositories: ["alice/app"] });
  w.stub.signIn("alice");
  const { url } = await w.backend.call("github.connect.begin", { returnTo: "app", start: "authorize" }, "alice-account");
  const authorize = new URL(url);
  assert.equal(authorize.origin + authorize.pathname, w.stub.url + "/login/oauth/authorize");
  assert.deepEqual([authorize.searchParams.get("client_id"), authorize.searchParams.get("redirect_uri"), authorize.searchParams.get("code_challenge_method")], [w.stub.clientId, SITE + "/github/callback", "S256"]);
  const landed = await w.open(url);
  assert.deepEqual(landed.visited.map((address) => new URL(address).pathname), ["/login/oauth/authorize", "/github/callback"]);
  const ticket = new URL(landed.url).searchParams.get("ticket");
  assert.deepEqual(await w.backend.call("github.connect.finish", { ticket }, "alice-account"), { connected: 1, githubLogin: "alice" });
  assert.equal((await w.access("alice/app", { appId: alice.appId })).installationId, 7101);
});

test("a forged installation id connects nothing: turtl binds only what GitHub lists for the person who came back", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  await w.connected("alice-account", "alice", { id: 7101, repositories: ["alice/app"] });
  const bob = await w.project("bob-account");

  // bob starts, then opens turtl's setup address with alice's installation id instead of installing anything.
  const url = await w.begin("bob-account", "bob");
  const state = new URL(url).searchParams.get("state");
  const landed = await w.open(`${SITE}/github/setup?installation_id=7101&setup_action=install&state=${state}`);
  assert.equal(new URL(landed.url).searchParams.get("github"), "none", "GitHub lists no installation bob can reach");
  assert.equal(new URL(landed.url).searchParams.get("ticket"), null);
  assert.deepEqual((await w.status("bob-account")).connections, []);
  assert.deepEqual(await w.pickable("bob-account"), []);
  assert.equal((await w.access("alice/app", { appId: bob.appId })).reason, "not_connected");
  assert.equal(w.backend.rows("githubInstallationLinks").filter((link) => link.account === "bob-account").length, 0);

  // Without a state the setup address shows a page and reads nothing at all.
  const before = w.backend.calls.length;
  const page = await w.http.setup(w.backend.ctx, new Request(`${SITE}/github/setup?installation_id=7101&setup_action=install`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Go back to turtl/);
  assert.equal(w.backend.calls.length, before);
});

test("an install link someone else started cannot connect your repositories to their turtl", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  const mallory = await w.project("mallory-account");
  // mallory starts on her account and sends the GitHub link to alice, who installs the app on her own repositories.
  const url = await w.begin("mallory-account", "mallory");
  w.stub.signIn("alice");
  w.stub.willInstall({ id: 7201, repositories: ["alice/app"] });
  const landed = await w.open(url);
  const ticket = new URL(landed.url).searchParams.get("ticket");
  assert.ok(ticket, "GitHub confirmed alice, and the ticket went to alice's device, not to mallory");
  // alice's app is signed in to alice's account, which did not start this attempt.
  await assert.rejects(w.backend.call("github.connect.finish", { ticket }, "alice-account"), EXPIRED);
  // mallory never saw the ticket; a guess gets the same answer.
  await assert.rejects(w.backend.call("github.connect.finish", { ticket: "x".repeat(43) }, "mallory-account"), EXPIRED);
  assert.deepEqual((await w.status("mallory-account")).connections, []);
  assert.equal((await w.access("alice/app", { appId: mallory.appId })).reason, "not_connected");
  assert.equal(w.backend.rows("githubInstallationLinks").every((link) => !link.active), true);
  // Nor can mallory have turtl uninstall alice's installation: disconnecting only forgets her unfinished attempt.
  assert.deepEqual(await w.backend.call("github.connect.disconnect", {}, "mallory-account"), { ok: true, disconnected: 0, failed: [] });
  assert.deepEqual(w.stub.uninstalled, []);
  assert.deepEqual(w.backend.rows("githubInstallationLinks"), []);
  assert.deepEqual(w.backend.rows("githubInstallations").map((row) => row.status), ["active"]);
});

test("a state is used once and lasts 15 minutes, and a ticket lasts 10", async (t) => {
  const w = await connectWorld(t, { accounts: true, now: START });
  const first = await w.connectAs("alice-account", "alice", { id: 7101, repositories: ["alice/app"] });
  const callback = first.landed.visited.find((address) => address.startsWith(SITE + "/github/callback"));
  const linksBefore = w.backend.rows("githubInstallationLinks").length;
  const replayed = await w.http.callback(w.backend.ctx, new Request(callback));
  assert.equal(replayed.status, 400);
  assert.match(await replayed.text(), /This link has expired/);
  assert.equal(w.backend.rows("githubInstallationLinks").length, linksBefore, "a replayed callback writes nothing");
  const unknown = await w.http.callback(w.backend.ctx, new Request(`${SITE}/github/callback?code=stub-code-1&state=${"a".repeat(43)}`));
  assert.equal(unknown.status, 400);

  t.mock.timers.setTime(START + 10 * MINUTE + 1);
  await assert.rejects(w.backend.call("github.connect.finish", { ticket: first.ticket }, "alice-account"), EXPIRED, "the ticket is older than 10 minutes");

  const late = await w.begin("alice-account", "alice", { existing: 7101 });
  t.mock.timers.setTime(START + 25 * MINUTE + 2);
  const expired = await w.open(late);
  assert.equal(expired.status, 200, "an expired state goes no further than the setup page");
  assert.match(expired.text, /Go back to turtl/);
  assert.equal(expired.visited.some((address) => address.includes("/login/oauth/authorize")), false);
  const lateState = new URL(late).searchParams.get("state");
  assert.equal((await w.http.callback(w.backend.ctx, new Request(`${SITE}/github/callback?code=x&state=${lateState}`))).status, 400);

  // Pressing Cancel on GitHub's authorize page ends the attempt; its state cannot be used again.
  w.stub.denyAuthorization();
  const cancelled = await w.connectAs("alice-account", "alice", { existing: 7101 });
  assert.equal(cancelled.result, "cancelled");
  assert.equal(w.backend.rows("githubConnectAttempts").at(-1).status, "failed");
  assert.deepEqual((await w.status("alice-account")).connections, []);
});

test("a second account cannot list or use the first account's repositories, and an organization member gets only what they can reach", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  await w.connected("alice-account", "alice", { id: 7101, repositories: ["alice/app", "alice/site"] });
  const bob = await w.project("bob-account");
  assert.deepEqual((await w.status("bob-account")).connections, []);
  assert.deepEqual(await w.pickable("bob-account"), []);
  assert.deepEqual(await w.backend.call("github.connect.refresh", {}, "bob-account"), { ok: true, problems: [] });
  const minted = w.mints().length;
  for (const owner of [{ appId: bob.appId }, { caseId: bob.caseId }]) {
    const refused = await w.access("alice/app", owner);
    assert.equal(refused.reason, "not_connected");
    assert.equal(JSON.stringify(refused).includes("ghs_stub_"), false);
  }
  assert.equal(w.mints().length, minted, "no token is minted for bob");

  // acme's installation covers three repositories. bob, a member, can reach one of them on GitHub.
  w.stub.install({ id: 7300, login: "acme", type: "Organization", repositories: ["acme/api", "acme/web", "acme/payroll"], members: { bob: ["acme/web"], carol: "all" } });
  assert.deepEqual(await w.connected("bob-account", "bob", { existing: 7300 }), { connected: 1, githubLogin: "bob" });
  assert.deepEqual(
    (await w.status("bob-account")).connections.map(({ installationId, accountLogin, scope, settingsUrl }) => ({ installationId, accountLogin, scope, settingsUrl })),
    [{ installationId: 7300, accountLogin: "acme", scope: "chosen", settingsUrl: w.stub.url + "/organizations/acme/settings/installations/7300" }],
  );
  assert.deepEqual(await w.backend.call("github.connect.refresh", {}, "bob-account"), { ok: true, problems: [] });
  assert.equal(w.backend.rows("githubInstallationRepositories").filter((row) => row.installationId === 7300).length, 3, "turtl's own records read all three");
  assert.deepEqual(await w.pickable("bob-account"), ["acme/web"], "bob is shown the one he can reach");
  assert.equal((await w.access("acme/web", { appId: bob.appId })).installationId, 7300);
  assert.equal((await w.access("acme/payroll", { appId: bob.appId })).reason, "not_connected");
  assert.deepEqual(await w.pickable("alice-account"), ["alice/app", "alice/site"]);
});

// Security review finding 3, written before Connect GitHub landed: with accounts on, no caller gets a repository token
// through an installation that is not linked to the project's owner, and a call that names no owner gets none at all.
test("an installation linked to one account covers its repository for that account only, and a call with no owner is refused", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  const alice = await w.project("alice-account");
  await w.connected("alice-account", "alice", { id: 7101, repositories: ["alice/app"] });
  assert.equal((await w.access("alice/app", { account: "alice-account" })).installationId, 7101);
  assert.equal((await w.access("alice/app", { appId: alice.appId })).installationId, 7101);
  const minted = w.mints().length;
  const orphan = await w.project(undefined);
  for (const owner of [{ account: "bob-account" }, { account: "" }, { appId: orphan.appId }, { caseId: orphan.caseId }, { appId: "apps:999" }, { appId: "not an id" }]) {
    const refused = await w.access("alice/app", owner);
    assert.equal(refused.ok, false, JSON.stringify(owner));
    assert.equal(refused.reason, "not_connected", JSON.stringify(owner));
    assert.equal(JSON.stringify(refused).includes("ghs_stub_"), false);
  }
  assert.equal(w.mints().length, minted, "no token was minted for anyone but alice");
});

test("disconnecting uninstalls the app at GitHub and leaves no token, repository or link behind", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  const alice = await w.project("alice-account");
  await w.connected("alice-account", "alice", { id: 7101, repositories: ["alice/app"] });
  assert.equal((await w.access("alice/app", { appId: alice.appId })).source, "installation");
  assert.equal(w.backend.rows("githubInstallationTokens").length, 1);

  assert.deepEqual(await w.backend.call("github.connect.disconnect", {}, "alice-account"), { ok: true, disconnected: 1, failed: [] });
  assert.deepEqual(w.stub.uninstalled, [7101]);
  const uninstall = w.stub.requests.find((request) => request.method === "DELETE" && request.path === "/app/installations/7101");
  assert.equal(uninstall.credential, "app", "uninstalled as the app, with its JWT");
  for (const table of ["githubInstallationTokens", "githubInstallationRepositories", "githubInstallationLinks", "githubConnectAttempts"]) assert.deepEqual(w.backend.rows(table), [], table);
  assert.deepEqual(w.backend.rows("githubInstallations").map((row) => row.status), ["deleted"]);
  assert.deepEqual((await w.status("alice-account")).connections, []);
  assert.equal((await w.access("alice/app", { appId: alice.appId })).ok, false);

  // When GitHub does not answer, nothing is removed, so it can be tried again.
  await w.connected("alice-account", "alice", { id: 7102, repositories: ["alice/app"] });
  w.stub.failWith(502);
  const failed = await w.backend.call("github.connect.disconnect", {}, "alice-account");
  assert.deepEqual([failed.ok, failed.disconnected, failed.failed.map((entry) => entry.installationId)], [false, 0, [7102]]);
  assert.match(failed.failed[0].message, /502/);
  w.stub.failWith(null);
  assert.equal((await w.status("alice-account")).connections.length, 1);
  assert.deepEqual(await w.backend.call("github.connect.disconnect", {}, "alice-account"), { ok: true, disconnected: 1, failed: [] });
  assert.deepEqual(w.stub.uninstalled, [7101, 7102]);
});

test("an installation two accounts use stays for the other, and account deletion disconnects without a caller", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  w.stub.install({ id: 7300, login: "acme", type: "Organization", repositories: ["acme/web"], members: { bob: "all", carol: "all" } });
  await w.connected("bob-account", "bob", { existing: 7300 });
  await w.connected("carol-account", "carol", { existing: 7300 });
  const carol = await w.project("carol-account");
  assert.equal((await w.access("acme/web", { appId: carol.appId })).installationId, 7300);

  assert.deepEqual(await w.backend.call("github.connect.disconnect", {}, "bob-account"), { ok: true, disconnected: 1, failed: [] });
  assert.deepEqual(w.stub.uninstalled, [], "carol still uses it");
  assert.deepEqual((await w.status("bob-account")).connections, []);
  assert.deepEqual(w.backend.rows("githubInstallationLinks").map((link) => link.account), ["carol-account"]);
  assert.equal((await w.access("acme/web", { appId: carol.appId })).installationId, 7300);

  // Account deletion (RC-23) calls the internal function with the account id; there is no signed-in caller.
  assert.deepEqual(await w.backend.run("internal.github.connect.disconnectAccount", { account: "carol-account" }), { ok: true, disconnected: 1, failed: [] });
  assert.deepEqual(w.stub.uninstalled, [7300]);
  assert.deepEqual(w.backend.rows("githubInstallationTokens"), []);
  assert.deepEqual(w.backend.rows("githubInstallationLinks"), []);
  assert.deepEqual(await w.backend.run("internal.github.connect.disconnectAccount", { account: "carol-account" }), { ok: true, disconnected: 0, failed: [] }, "running it again is harmless");
});

test("uninstalling on GitHub ends the connection too", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  await w.connected("alice-account", "alice", { id: 7101, repositories: ["alice/app"] });
  w.stub.installations.delete(7101);
  assert.equal((await w.deliver("installation", lifecycle("deleted", 7101, "alice", "2026-11-15T12:30:00Z"))).body.outcome, "applied");
  assert.deepEqual(w.backend.rows("githubInstallationLinks"), []);
  assert.deepEqual((await w.status("alice-account")).connections, []);
});

test("in the single-owner demo, Connect GitHub files the installation under the one owner, and disconnecting needs the owner passcode", async (t) => {
  const w = await connectWorld(t);
  assert.deepEqual(await w.connected(null, "ronok", { id: 7400, repositories: ["ronok/turtl"] }), { connected: 1, githubLogin: "ronok" });
  const status = await w.status(null);
  assert.deepEqual([status.accounts, status.signedIn, status.connections.map((connection) => connection.installationId)], [false, true, [7400]]);
  assert.deepEqual(w.backend.rows("githubInstallationLinks").map((link) => link.account), [SOLO]);

  await assert.rejects(w.backend.call("github.connect.disconnect", {}, null), /Set an owner passcode in project settings before disconnecting GitHub/);
  await w.backend.insert("ownerPasscodeConfig", { passcodeDigest: createHash("sha256").update("correct horse").digest("hex") });
  await assert.rejects(w.backend.call("github.connect.disconnect", { passcode: "wrong" }, null), /owner passcode is incorrect/);
  assert.deepEqual(w.stub.uninstalled, []);
  assert.equal((await w.backend.call("github.connect.disconnect", { passcode: "correct horse" }, null)).ok, true);
  assert.deepEqual(w.stub.uninstalled, [7400]);
});

test("with no Connect variables the app sees no GitHub connection, and repositories use today's credential", async (t) => {
  const w = await world(t, { app: false });
  process.env.GITHUB_TOKEN = LEGACY_TOKEN;
  assert.deepEqual(await w.backend.call("github.connect.status", {}, null), { configured: false, accounts: false, signedIn: true, connections: [] });
  assert.deepEqual(await w.backend.call("github.connect.repositories", {}, null), []);
  await assert.rejects(w.backend.call("github.connect.begin", { returnTo: "app" }, null), /not set up on this turtl backend/);
  const before = w.backend.calls.length;
  for (const owner of [{ appId: "apps:1" }, { caseId: "cases:1" }, { account: SOLO }]) {
    assert.deepEqual(await w.access("octo/app", owner), { ok: true, source: "deployment", token: LEGACY_TOKEN });
  }
  assert.equal(w.backend.calls.length, before, "no table is read");
  assert.deepEqual(w.stub.requests, []);

  // The app alone, without the client id and secret, still cannot connect: the screen stays as it is today.
  Object.assign(process.env, { GITHUB_APP_ID: APP_ID, GITHUB_APP_SLUG: "turtl-on-call", GITHUB_APP_PRIVATE_KEY: PKCS1, GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET });
  assert.equal((await w.backend.call("github.connect.status", {}, null)).configured, false);
  // With accounts off, the owner is not asked: any installation that covers the repository serves it, as before.
  w.stub.install({ id: 7001, login: "octo", repositories: ["octo/app"] });
  assert.equal((await w.access("octo/app", { appId: "apps:404" })).installationId, 7001);
  assert.equal(w.backend.calls.some((path) => path.includes("links")), false);
});

test("GitHub sends the person back only to the turtl app, or to the web app on this computer", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  for (const returnTo of ["https://evil.example", "http://evil.example:8108", "http://localhost:8108/", "http://localhost:8108/elsewhere", "javascript:alert(1)", "turtl://elsewhere", ""]) {
    await assert.rejects(w.backend.call("github.connect.begin", { returnTo }, "alice-account"), /only bring you back to the turtl app/, returnTo);
  }
  const web = await w.connectAs("alice-account", "alice", { id: 7101, repositories: ["alice/app"] }, "http://localhost:8108");
  assert.equal(web.back.origin + web.back.pathname, "http://localhost:8108/add-project");
  assert.equal(web.result, "connected");
  assert.deepEqual(await w.backend.call("github.connect.finish", { ticket: web.ticket }, "alice-account"), { connected: 1, githubLogin: "alice" });
  // An organization owner must approve first: the person comes back with that, and nothing else.
  const requested = await w.connectAs("alice-account", "alice", { request: true });
  assert.deepEqual([requested.result, requested.ticket], ["requested", null]);
});

// The app's side, data/github: loaded with every import stubbed, the way tests/onboarding.test.mjs loads data/onboarding.
function loadClient(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: path })(
    (name) => {
      assert.ok(name in imports, "Unexpected import: " + name);
      return imports[name];
    },
    module.exports,
    module,
  );
  return module.exports;
}

test("the app asks GitHub to come back to turtl:// on a phone and to the page's origin on the web, and asks the passcode only in the demo", async (t) => {
  const calls = [];
  const passcodes = [];
  const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
  const client = {
    action: async (fn, args) => (calls.push([fn.path, args]), fn.path.endsWith("begin") ? { url: "https://github.com/apps/turtl/installations/new?state=s" } : { ok: true, disconnected: 1, failed: [] }),
    mutation: async (fn, args) => (calls.push([fn.path, args]), { connected: 1, githubLogin: "maya" }),
  };
  const live = (os) =>
    loadClient("../data/github/live.ts", {
      "react-native": { Platform: { OS: os } },
      "../../convex/_generated/api": { api: ref("api") },
      "../live/client": { errorMessage: (error) => error.message, requireLiveClient: () => client, useLiveQuery: (fn, args) => [fn.path, args] },
      "../live/ownerPasscode": { withOwnerPasscode: (work) => (passcodes.push("asked"), work("owner-passcode")) },
    });
  assert.equal(await live("ios").beginGithubConnect(), "https://github.com/apps/turtl/installations/new?state=s");
  globalThis.window = { location: { origin: "http://localhost:8108" } };
  t.after(() => delete globalThis.window);
  await live("web").beginGithubConnect();
  await live("ios").beginGithubConnect("authorize");
  assert.deepEqual(calls.splice(0), [
    ["api.github.connect.begin", { returnTo: "app" }],
    ["api.github.connect.begin", { returnTo: "http://localhost:8108" }],
    ["api.github.connect.begin", { returnTo: "app", start: "authorize" }],
  ]);

  await live("ios").disconnectGithub(true);
  assert.deepEqual([calls.splice(0), passcodes.splice(0)], [[["api.github.connect.disconnect", {}]], []], "accounts on: the signed-in account decides");
  await live("ios").disconnectGithub(false);
  assert.deepEqual([calls.splice(0), passcodes.splice(0)], [[["api.github.connect.disconnect", { passcode: "owner-passcode" }]], ["asked"]], "the demo: an owner decision");
  assert.deepEqual(live("ios").useGithubRepositories(false), ["api.github.connect.repositories", "skip"]);

  const example = loadClient("../data/github/example.ts", {});
  assert.deepEqual(example.useGithubStatus(), { configured: false, accounts: false, signedIn: true, connections: [] }, "the example data draws no GitHub section");
  assert.deepEqual(example.useGithubRepositories(), []);
  await assert.rejects(example.beginGithubConnect(), /needs a turtl backend/);
  await assert.rejects(example.disconnectGithub(false), /needs a turtl backend/);
});
