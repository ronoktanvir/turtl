import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { connectWorld, createLoader, MINUTE, START } from "./github-harness.mjs";

// Second security review, finding 16: GitHub lists, for a person, every repository they can reach in an installation,
// reading included, and turtl's GitHub App can change every repository it covers. These tests perform the attacks
// against the real convex/github modules and the GitHub stand-in (scripts/github-app/stub.mjs), and see them refused:
//
// 1. Connecting links only repositories the person can change (push, maintain or admin).
// 2. A link does not outlive the permission: refresh drops what the person can no longer change, and turtl asks GitHub
//    again, by the person's GitHub id, before it merges or starts a coding agent's work.
// 3. Disconnecting, or deleting the account, uninstalls only an installation on the person's own GitHub account.
// 4. A loopback return address is accepted only on a local backend.
// 5. turtl refuses a coding agent's work itself, whatever the coding agent would allow.
// 6. The single-owner demo is unchanged.
//
// In acme (an organization), members map a login to a role per repository, as the stand-in reads it.

const READ_ONLY = "You can read this repository but not change it, so turtl cannot open pull requests on it.";
const LOST = "You can no longer change this repository on GitHub, so turtl stopped using it for you.";
const STILL_IN_ACME = "turtl stopped using acme for you, but its app is still installed on acme. Only an owner of acme can remove it, in acme's settings on GitHub.";
const CANNOT = /^You can no longer change acme\/web on GitHub, so turtl will not change it for you\. If you should be able to, ask an owner of acme for write access, then connect GitHub again in turtl\.$/;

const acme = (members) => ({ id: 7300, login: "acme", type: "Organization", repositories: ["acme/api", "acme/web"], members });
const linkOf = (w, account) => w.backend.rows("githubInstallationLinks").find((row) => row.account === account && row.active);
const uninstalls = (w) => w.stub.requests.filter((request) => request.method === "DELETE" && request.path.startsWith("/app/installations/"));
const asked = (w) => w.stub.requests.filter((request) => /\/collaborators\/|^\/user\/\d+$/.test(request.path)).map((request) => request.path);

test("1. a member who can only read a repository gets no link to it and no token for it, and the app says why", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  w.stub.install(acme({ mallory: { "acme/web": "read", "acme/api": "triage" }, maya: { "acme/web": "maintain" }, ada: { "*": "admin" } }));
  const mallory = await w.project("mallory-account");
  assert.deepEqual(await w.connected("mallory-account", "mallory", { existing: 7300 }), { connected: 1, githubLogin: "mallory" });

  // GitHub listed both repositories for her, with read and triage, so her link holds neither.
  const link = linkOf(w, "mallory-account");
  assert.deepEqual(link.repositories, [], "her link holds no repository");
  assert.equal(link.githubUserId, w.stub.userId("mallory"), "the link keeps GitHub's id for her, not only her login");
  assert.deepEqual(link.leftOut.map((entry) => [entry.fullName, entry.why]).sort(), [["acme/api", "read_only"], ["acme/web", "read_only"]]);
  assert.deepEqual(await w.pickable("mallory-account"), []);

  // repositoryAccess refuses, and no installation token is minted for her.
  const minted = w.mints().length;
  for (const owner of [{ appId: mallory.appId }, { caseId: mallory.caseId }, { account: "mallory-account" }]) {
    const refused = await w.access("acme/web", owner);
    assert.deepEqual([refused.ok, refused.reason], [false, "not_connected"]);
    assert.equal(JSON.stringify(refused).includes("ghs_stub_"), false);
  }
  assert.equal(w.mints().length, minted, "no token minted for mallory");

  // The app shows why each repository is missing, in plain words, under the picker.
  const refreshed = await w.backend.call("github.connect.refresh", {}, "mallory-account");
  assert.deepEqual(refreshed, {
    ok: true,
    problems: [],
    leftOut: [
      { fullName: "acme/api", message: READ_ONLY },
      { fullName: "acme/web", message: READ_ONLY },
    ],
  });

  // Push, maintain and admin all count as able to change it.
  await w.connected("maya-account", "maya", { existing: 7300 });
  assert.deepEqual(linkOf(w, "maya-account").repositories, ["acme/web"]);
  await w.connected("ada-account", "ada", { existing: 7300 });
  assert.deepEqual(linkOf(w, "ada-account").repositories.sort(), ["acme/api", "acme/web"]);
  assert.equal(linkOf(w, "ada-account").leftOut, undefined);
});

test("2. refresh drops a repository the person can no longer change, at most once every five minutes", async (t) => {
  const w = await connectWorld(t, { accounts: true, now: START });
  w.stub.install(acme({ bob: { "acme/web": "write", "acme/api": "write" } }));
  const bob = await w.project("bob-account");
  await w.connected("bob-account", "bob", { existing: 7300 });
  assert.deepEqual((await w.pickable("bob-account")).sort(), ["acme/api", "acme/web"]);
  assert.equal(linkOf(w, "bob-account").checkedAt, START, "GitHub's own answer at connect counts as a check");

  // acme takes bob's write access to acme/web away. GitHub tells turtl nothing.
  w.stub.setMember(7300, "bob", { "acme/web": "read", "acme/api": "write" });
  const before = asked(w).length;
  assert.deepEqual(await w.backend.call("github.connect.refresh", {}, "bob-account"), { ok: true, problems: [], leftOut: [] });
  assert.equal(asked(w).length, before, "checked less than five minutes ago: GitHub is not asked again");

  t.mock.timers.setTime(START + 5 * MINUTE + 1);
  assert.deepEqual(await w.backend.call("github.connect.refresh", {}, "bob-account"), { ok: true, problems: [], leftOut: [{ fullName: "acme/web", message: LOST }] });
  assert.deepEqual(asked(w).slice(before).sort(), [`/repos/acme/api/collaborators/bob/permission`, `/repos/acme/web/collaborators/bob/permission`, `/user/${w.stub.userId("bob")}`]);
  assert.deepEqual(linkOf(w, "bob-account").repositories, ["acme/api"]);
  assert.equal(linkOf(w, "bob-account").checkedAt, START + 5 * MINUTE + 1);
  assert.deepEqual(await w.pickable("bob-account"), ["acme/api"]);
  assert.equal((await w.access("acme/web", { appId: bob.appId })).reason, "not_connected");
  assert.equal((await w.access("acme/api", { appId: bob.appId })).ok, true);

  // Removed from acme altogether: the next refresh drops the rest.
  w.stub.setMember(7300, "bob", undefined);
  t.mock.timers.setTime(START + 11 * MINUTE);
  const last = await w.backend.call("github.connect.refresh", {}, "bob-account");
  assert.deepEqual(last.leftOut.map((entry) => entry.fullName), ["acme/api", "acme/web"]);
  assert.deepEqual(linkOf(w, "bob-account").repositories, []);
});

test("2. turtl asks GitHub before it changes a repository, by the person's GitHub id, and refuses when they can no longer change it", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  w.stub.install(acme({ carol: { "acme/web": "write" }, dave: { "acme/web": "write" } }));
  const carol = await w.project("carol-account");
  await w.connected("carol-account", "carol", { existing: 7300 });
  const allowed = await w.access("acme/web", { appId: carol.appId }, "change");
  assert.deepEqual([allowed.ok, allowed.installationId], [true, 7300], "while she can push, turtl may change it for her");
  assert.deepEqual(asked(w), [`/user/${w.stub.userId("carol")}`, "/repos/acme/web/collaborators/carol/permission"], "asked as the installation, by id first");
  assert.ok(w.stub.requests.filter((request) => /\/collaborators\/|^\/user\/\d+$/.test(request.path)).every((request) => request.credential === "installation"));

  // carol is made read-only on GitHub. Reading still works until refresh; changing is refused at once.
  w.stub.setMember(7300, "carol", { "acme/web": "read" });
  assert.equal((await w.access("acme/web", { appId: carol.appId })).ok, true, "a read does not ask GitHub every time");
  const refused = await w.access("acme/web", { appId: carol.appId }, "change");
  assert.deepEqual([refused.ok, refused.reason], [false, "cannot_push"]);
  assert.match(refused.message, CANNOT);
  assert.equal(JSON.stringify(refused).includes("ghs_stub_"), false);
  // And the link no longer holds it, so reads stop too.
  assert.deepEqual(linkOf(w, "carol-account").repositories, []);
  assert.deepEqual(linkOf(w, "carol-account").leftOut, [{ fullName: "acme/web", why: "lost" }]);
  assert.equal((await w.access("acme/web", { appId: carol.appId })).reason, "not_connected");

  // A login can change hands. dave connects, renames himself, loses write access, and someone else takes "dave" and
  // is made an admin. turtl asks about dave by his id, so it is not fooled.
  const dave = await w.project("dave-account");
  await w.connected("dave-account", "dave", { existing: 7300 });
  const daveId = w.stub.userId("dave");
  w.stub.renameUser("dave", "dave-renamed");
  w.stub.setMember(7300, "dave-renamed", { "acme/web": "read" });
  w.stub.setMember(7300, "dave", { "acme/web": "admin" });
  assert.notEqual(w.stub.userId("dave"), daveId);
  const impostor = await w.access("acme/web", { appId: dave.appId }, "change");
  assert.equal(impostor.reason, "cannot_push");
  assert.ok(asked(w).includes("/repos/acme/web/collaborators/dave-renamed/permission"));
  assert.ok(!asked(w).includes("/repos/acme/web/collaborators/dave/permission"));

  // GitHub not answering is a no.
  const erin = await w.project("erin-account");
  w.stub.setMember(7300, "erin", { "acme/web": "write" });
  await w.connected("erin-account", "erin", { existing: 7300 });
  w.stub.failWith(502);
  const unsure = await w.access("acme/web", { appId: erin.appId }, "change");
  w.stub.failWith(null);
  assert.equal(unsure.ok, false);
});

// Loads a module that acts for an owner (pull requests, onboarding, the coding agent), with the parts that need the
// rest of turtl replaced by what the owner's tap would have found: the caller owns the case, the passcode is not
// asked, and the pull request is open.
async function ownerWorld(t, caller) {
  const real = createLoader()("convex/access.ts");
  const mocks = {
    "convex/access": { ...real, guardCaseInAction: async () => caller, guardAppInAction: async () => caller },
    "convex/consent/gate": { gateFor: () => ({}) },
    "convex/secrets/open": { openSecret: async () => ({ ok: true, value: "owner-capy-key" }) },
    "convex/prTracking/catalog": { registerCodeChangeAction: async () => null },
    "convex/prTracking/records": { latestForCase: async () => null, toPullRequest: (row) => row },
    "convex/protectedApp/client": { readRevision: async () => null },
    "convex/protectedApp/watched": { watchedApp: async () => null },
    "convex/onboarding/prepare": { syncPreparation: async () => null },
    "convex/onboarding/records": { latestInspection: async () => null, preparationFor: async () => null },
    "convex/ownerPasscode": { requireOwnerPasscode: async () => null },
  };
  const overrides = {
    "internal.ownerPasscode.authorize": async () => null,
    "internal.prTracking.records.forCase": async ({ caseId }) => ({ _id: "pullRequests:1", caseId, repo: "acme/web", number: 7, requestedAt: 0 }),
    "internal.onboarding.records.forApp": async ({ projectId }) => ({ _id: "onboardingPreparations:1", appId: projectId, repo: "acme/web", number: 7 }),
  };
  return await connectWorld(t, { accounts: true, mocks, overrides });
}

test("2 and 5. someone whose write access was taken away after connecting cannot merge, or start a coding agent's work", async (t) => {
  const w = await ownerWorld(t, "mallory-account");
  w.stub.install(acme({ mallory: { "acme/web": "write" } }));
  const mallory = await w.project("mallory-account");
  await w.connected("mallory-account", "mallory", { existing: 7300 });
  // She was a collaborator; acme makes her read-only. turtl's link still lists acme/web, and nobody tapped refresh.
  w.stub.setMember(7300, "mallory", { "acme/web": "read" });
  assert.deepEqual(linkOf(w, "mallory-account").repositories, ["acme/web"]);

  // A case's Merge tap (convex/pullRequests.ts).
  const merged = await w.backend.call("pullRequests.merge", { caseId: mallory.caseId, headSha: "abc" }, "mallory-account");
  assert.equal(merged.outcome, "failed");
  assert.match(merged.message, CANNOT);
  // A preparation's Merge tap (convex/onboarding/projects.ts).
  w.stub.setMember(7300, "mallory", { "acme/web": "write" });
  await w.connected("mallory-account", "mallory", { existing: 7300 });
  w.stub.setMember(7300, "mallory", { "acme/web": "read" });
  const prepared = await w.backend.call("onboarding.projects.merge", { projectId: mallory.appId, headSha: "abc" }, "mallory-account");
  assert.equal(prepared.ok, false);
  assert.match(prepared.reason, /^You can no longer change acme\/web on GitHub.* Nothing was merged\.$/);
  // Starting the coding agent's work, for a fix or a preparation (convex/prTracking/codingAgent.ts). turtl refuses on
  // its own, before anything reaches the coding agent, whatever the coding agent would allow.
  w.stub.setMember(7300, "mallory", { "acme/web": "write" });
  await w.connected("mallory-account", "mallory", { existing: 7300 });
  w.stub.setMember(7300, "mallory", { "acme/web": "read" });
  const { codingAgentFor } = w.load("convex/prTracking/codingAgent.ts");
  const agent = await codingAgentFor(w.backend.ctx, { appId: mallory.appId }, "acme/web");
  assert.equal(agent.ok, false);
  assert.match(agent.reason, CANNOT);

  // Nothing read or merged the pull request: every refusal came before it.
  assert.deepEqual(w.stub.requests.filter((request) => request.path.includes("/pulls/")), []);

  // While she can change it, the same calls go ahead (the coding agent gets her own key).
  w.stub.setMember(7300, "mallory", { "acme/web": "write" });
  await w.connected("mallory-account", "mallory", { existing: 7300 });
  assert.deepEqual(await codingAgentFor(w.backend.ctx, { appId: mallory.appId }, "acme/web"), { ok: true, apiKey: "owner-capy-key", own: true });
});

test("2. a link made before turtl asked about write access is checked before it is used, once", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  w.stub.install(acme({ mallory: { "acme/web": "read" }, bob: { "acme/web": "write" } }));
  w.stub.userId("mallory");
  w.stub.userId("bob");
  // Two links as Connect GitHub wrote them before this change: every repository GitHub listed, and no checkedAt.
  const old = async (account, login) => {
    const attemptId = await w.backend.insert("githubConnectAttempts", { account, stateHash: "s-" + login, codeVerifier: "", returnTo: "turtl://add-project", status: "finished", expiresAt: 1 });
    await w.backend.insert("githubInstallationLinks", { account, installationId: 7300, attemptId, active: true, githubUserId: w.stub.userId(login), githubLogin: login, repositories: ["acme/web"], confirmedAt: 1 });
  };
  await old("mallory-account", "mallory");
  await old("bob-account", "bob");
  await w.backend.insert("githubInstallations", { installationId: 7300, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active", updatedAt: 1 });
  await w.backend.insert("githubInstallationRepositories", { installationId: 7300, fullName: "acme/web", fullNameLower: "acme/web", seenAt: 1 });
  const mallory = await w.project("mallory-account");
  const bob = await w.project("bob-account");

  const refused = await w.access("acme/web", { appId: mallory.appId });
  assert.deepEqual([refused.ok, refused.reason], [false, "cannot_push"]);
  assert.deepEqual(linkOf(w, "mallory-account").repositories, []);
  assert.equal(typeof linkOf(w, "mallory-account").checkedAt, "number");
  assert.equal((await w.access("acme/web", { appId: mallory.appId })).reason, "not_connected");

  const before = asked(w).length;
  assert.equal((await w.access("acme/web", { appId: bob.appId })).ok, true);
  assert.equal(asked(w).length, before + 2, "bob's old link is checked once");
  assert.equal((await w.access("acme/web", { appId: bob.appId })).ok, true);
  assert.equal(asked(w).length, before + 2, "and then trusted for reading");
});

test("3. a member's disconnect, or account deletion, never uninstalls an organization's installation, and no token is minted for them afterwards", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  w.stub.install(acme({ mallory: { "acme/web": "read" }, nina: { "acme/web": "write" } }));
  // mallory, read-only, is the only turtl account linked to acme.
  await w.connected("mallory-account", "mallory", { existing: 7300 });
  const disconnected = await w.backend.call("github.connect.disconnect", {}, "mallory-account");
  assert.deepEqual(uninstalls(w), [], "no DELETE /app/installations/7300");
  assert.deepEqual(w.stub.uninstalled, []);
  assert.deepEqual(disconnected, { ok: true, disconnected: 1, failed: [], stillInstalled: [{ installationId: 7300, accountLogin: "acme", message: STILL_IN_ACME }] });
  assert.deepEqual(w.backend.rows("githubInstallations").map((row) => row.status), ["active"]);

  // nina can push, used turtl (so a token is cached), and is the last account linked. Deleting her account unlinks.
  const nina = await w.project("nina-account");
  await w.connected("nina-account", "nina", { existing: 7300 });
  assert.equal((await w.access("acme/web", { appId: nina.appId })).installationId, 7300);
  assert.equal(w.backend.rows("githubInstallationTokens").length, 1);
  const deleted = await w.backend.run("internal.github.connect.disconnectAccount", { account: "nina-account" });
  assert.deepEqual(uninstalls(w), []);
  assert.deepEqual(deleted, { ok: true, disconnected: 1, failed: [], stillInstalled: [{ installationId: 7300, accountLogin: "acme", message: STILL_IN_ACME }] });
  assert.deepEqual(w.backend.rows("githubInstallationTokens"), [], "the cached token is dropped");
  assert.deepEqual(w.backend.rows("githubInstallationLinks"), []);

  // Afterwards no path mints a token for acme on her behalf: not repositoryAccess (which asks GitHub, finds acme's
  // installation, and finds no link), not refresh, not the picker.
  const minted = w.mints().length;
  for (const purpose of ["read", "change"]) assert.equal((await w.access("acme/web", { appId: nina.appId }, purpose)).reason, "not_connected");
  assert.deepEqual(await w.backend.call("github.connect.refresh", {}, "nina-account"), { ok: true, problems: [], leftOut: [] });
  assert.deepEqual(await w.pickable("nina-account"), []);
  assert.deepEqual((await w.status("nina-account")).connections, []);
  assert.equal(w.mints().length, minted);

  // An installation on the person's own account is still theirs to remove. (Connecting again links acme too, since
  // GitHub still lists it for her; that one stays.)
  await w.connected("nina-account", "nina", { id: 7101, repositories: ["nina/app"] });
  assert.deepEqual(await w.backend.call("github.connect.disconnect", {}, "nina-account"), {
    ok: true,
    disconnected: 2,
    failed: [],
    stillInstalled: [{ installationId: 7300, accountLogin: "acme", message: STILL_IN_ACME }],
  });
  assert.deepEqual(w.stub.uninstalled, [7101]);
  assert.deepEqual(uninstalls(w).map((request) => request.path), ["/app/installations/7101"]);
});

test("4. a loopback return address is refused on a hosted deployment with accounts on, and accepted on a local backend", async (t) => {
  const w = await connectWorld(t, { accounts: true });
  process.env.CONVEX_CLOUD_URL = "https://happy-otter-123.convex.cloud";
  for (const returnTo of ["http://localhost:8108", "http://127.0.0.1:8081", "http://[::1]:19006"]) {
    await assert.rejects(w.backend.call("github.connect.begin", { returnTo }, "alice-account"), /only bring you back to the turtl app/, returnTo);
  }
  assert.match((await w.backend.call("github.connect.begin", { returnTo: "app" }, "alice-account")).url, /^https:\/\/github\.com\/apps\/turtl-on-call\/installations\/new\?state=/);
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
  assert.ok((await w.backend.call("github.connect.begin", { returnTo: "http://localhost:8108" }, "alice-account")).url);
});

test("6. the single-owner demo links, reaches, merges through and uninstalls as before, and never asks GitHub about the person", async (t) => {
  const w = await connectWorld(t);
  w.stub.install(acme({ ronok: { "acme/web": "read" } }));
  await w.connected(null, "ronok", { existing: 7300 });
  const link = linkOf(w, "solo-owner");
  assert.deepEqual([link.repositories, link.checkedAt, link.leftOut], [["acme/web"], undefined, undefined], "every repository GitHub listed, as before");
  assert.deepEqual(await w.pickable(null), ["acme/web"]);
  for (const purpose of ["read", "change"]) assert.equal((await w.access("acme/web", { appId: "apps:1" }, purpose)).installationId, 7300);
  assert.deepEqual(await w.backend.call("github.connect.refresh", {}, null), { ok: true, problems: [], leftOut: [] });
  assert.deepEqual(asked(w), []);
  // A demo deployment that is not a local backend still accepts the web app on this computer.
  process.env.CONVEX_CLOUD_URL = "https://happy-otter-123.convex.cloud";
  assert.ok((await w.backend.call("github.connect.begin", { returnTo: "http://localhost:8108" }, null)).url);
  // Disconnecting is still the owner's decision, behind the passcode, and uninstalls.
  await w.backend.insert("ownerPasscodeConfig", { passcodeDigest: createHash("sha256").update("correct horse").digest("hex") });
  assert.deepEqual(await w.backend.call("github.connect.disconnect", { passcode: "correct horse" }, null), { ok: true, disconnected: 1, failed: [], stillInstalled: [] });
  assert.deepEqual(w.stub.uninstalled, [7300]);
});
