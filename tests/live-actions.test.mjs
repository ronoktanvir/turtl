import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { errorMessage } = load("../data/live/client.ts", {
  "convex/react": { ConvexReactClient: class {} },
  "convex/server": {},
  react: {},
  "../source": { isLiveData: false },
});

const refs = {
  fixes: { forCase: "fixes:forCase" },
  decisions: { approve: "decisions:approve" },
  pullRequests: { merge: "pullRequests:merge" },
  screens: { projects: { approvalSettings: "screens/projects:approvalSettings" } },
  permissions: { grant: "permissions:grant", revoke: "permissions:revoke" },
  cases: { setStarred: "cases:setStarred" },
};

function actions() {
  const calls = [];
  const handlers = new Map();
  let connected = true;
  const client = Object.fromEntries(["query", "mutation", "action"].map((kind) => [kind, async (ref, args) => {
    calls.push({ kind, ref, args });
    assert.ok(handlers.has(ref), `Unexpected backend call: ${ref}`);
    return handlers.get(ref)(args);
  }]));
  const exports = load("../data/live/actions.ts", {
    "convex/server": { makeFunctionReference: (name) => name },
    "../../convex/_generated/api": { api: refs },
    "./client": {
      errorMessage,
      requireLiveClient: () => {
        if (!connected) throw new Error("The backend URL is not configured.");
        return client;
      },
    },
  });
  return {
    ...exports,
    calls,
    on: (ref, handler) => handlers.set(ref, handler),
    returns: (ref, value) => handlers.set(ref, () => value),
    disconnect: () => { connected = false; },
  };
}

const proposal = {
  proposalId: "proposal-7",
  version: 7,
  fixes: [{ key: "recovery", recommended: true }, { key: "repair", recommended: false }],
};

test("Approve forwards the selected option and the latest proposal id and version", async () => {
  const a = actions();
  a.returns(refs.fixes.forCase, proposal);
  a.returns(refs.decisions.approve, { actionId: "action-1" });
  assert.equal(await a.approveFix("case-1", "repair"), undefined);
  assert.deepEqual(a.calls, [
    { kind: "query", ref: refs.fixes.forCase, args: { caseId: "case-1" } },
    { kind: "mutation", ref: refs.decisions.approve, args: { proposalId: "proposal-7", version: 7, optionKey: "repair" } },
  ]);
  a.returns(refs.fixes.forCase, { ...proposal, proposalId: "proposal-8", version: 8 });
  await a.approveFix("case-1", "repair");
  assert.deepEqual(a.calls.at(-1).args, { proposalId: "proposal-8", version: 8, optionKey: "repair" });
});

test("Approve refuses absent proposals and missing options without authorizing anything", async () => {
  for (const current of [null, { ...proposal, proposalId: null }, { ...proposal, version: null }]) {
    const a = actions();
    a.returns(refs.fixes.forCase, current);
    await assert.rejects(a.approveFix("case-1", "repair"), /No proposed fix is available/);
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].kind, "query");
  }
  const a = actions();
  a.returns(refs.fixes.forCase, proposal);
  await assert.rejects(a.approveFix("case-1", "removed-option"), /no longer in the proposal/);
  assert.equal(a.calls.length, 1);
});

test("Approve reports missing queries and preserves the backend's stale-proposal refusal", async () => {
  const a = actions();
  a.on(refs.fixes.forCase, () => { throw new Error("[CONVEX Q(fixes:forCase)] Could not find public function fixes:forCase"); });
  await assert.rejects(a.approveFix("case-1", "repair"), /backend has not been updated.*No example data was substituted/);
  assert.equal(a.calls.length, 1);
  a.returns(refs.fixes.forCase, proposal);
  a.on(refs.decisions.approve, () => { throw new Error("[CONVEX M(decisions:approve)] Server Error\nUncaught Error: Version 7 is out of date: the latest proposal is version 8.\n    at approve (decisions.ts:10)"); });
  await assert.rejects(a.approveFix("case-1", "repair"), { message: "Version 7 is out of date: the latest proposal is version 8." });
});

test("Stop calls the backend for this case and resolves only when it reports stopped", async () => {
  const a = actions();
  a.returns("decisions:stop", { stopped: true, summary: "Stopped before the next step." });
  assert.equal(await a.stopEnactment("case-1"), undefined);
  assert.deepEqual(a.calls, [{ kind: "mutation", ref: "decisions:stop", args: { caseId: "case-1" } }]);
  a.returns("decisions:stop", { stopped: false, reason: "The action already reached the provider and cannot be recalled." });
  await assert.rejects(a.stopEnactment("case-1"), { message: "The action already reached the provider and cannot be recalled." });
});

test("Stop reports a missing function instead of pretending the work stopped", async () => {
  const a = actions();
  a.on("decisions:stop", () => { throw new Error("[CONVEX M(decisions:stop)] Could not find public function decisions:stop"); });
  await assert.rejects(a.stopEnactment("case-1"), /backend has not been updated.*No example data was substituted/);
});

test("Merge forwards exactly the head shown to the owner for every backend outcome", async () => {
  for (const [result, expected] of [
    [{ outcome: "merged", pullRequest: { headSha: "backend-head" } }, { ok: true }],
    [{ outcome: "refused", reason: "New commits arrived. Look again before merging." }, { ok: false, reason: "New commits arrived. Look again before merging." }],
    [{ outcome: "not_configured", missing: ["GITHUB_TOKEN", "MERGE_ENABLED"] }, { ok: false, reason: "Merging from turtl is not set up yet. You can still merge it on GitHub." }],
    [{ outcome: "not_configured", missing: ["your coding agent's key (Settings, Coding agent)"] }, { ok: false, reason: "turtl needs your coding agent's key (Settings, Coding agent) before it can merge this. You can still merge it on GitHub." }],
    [{ outcome: "failed", message: "GitHub could not complete the merge." }, { ok: false, reason: "GitHub could not complete the merge." }],
  ]) {
    const a = actions();
    a.returns(refs.pullRequests.merge, result);
    assert.deepEqual(await a.mergePullRequest("case-1", "owner-saw-this-exact-head"), expected);
    assert.deepEqual(a.calls, [{ kind: "action", ref: refs.pullRequests.merge, args: { caseId: "case-1", headSha: "owner-saw-this-exact-head" } }]);
  }
});

test("Merge returns readable failures for missing functions and transport errors", async () => {
  const a = actions();
  a.on(refs.pullRequests.merge, () => { throw new Error("Could not find public function pullRequests:merge"); });
  assert.deepEqual(await a.mergePullRequest("case-1", "shown-head"), {
    ok: false,
    reason: "This backend has not been updated for this control yet. No example data was substituted.",
  });
  a.on(refs.pullRequests.merge, () => { throw new Error("Connection lost before a merge was confirmed."); });
  assert.deepEqual(await a.mergePullRequest("case-1", "shown-head"), { ok: false, reason: "Connection lost before a merge was confirmed." });
});

test("Auto refuses a recovery below the backend's verified threshold", async () => {
  const a = actions();
  const reason = "Auto needs two verified recoveries of the same action. No recovery qualifies yet.";
  a.returns(refs.screens.projects.approvalSettings, { active: false, canEnable: false, memoryId: null, permissionIds: [], reason });
  await assert.rejects(a.setApprovals("app-1", "auto"), { message: reason });
  assert.deepEqual(a.calls, [{ kind: "query", ref: refs.screens.projects.approvalSettings, args: { projectId: "app-1" } }]);
});

test("Auto grants only the backend-selected recovery memory, not blanket project approval", async () => {
  const a = actions();
  a.returns(refs.screens.projects.approvalSettings, { active: false, canEnable: true, memoryId: "verified-memory-2", permissionIds: [], reason: "One bounded recovery qualifies." });
  a.returns(refs.permissions.grant, "permission-1");
  assert.equal(await a.setApprovals("app-1", "auto"), undefined);
  assert.deepEqual(a.calls, [
    { kind: "query", ref: refs.screens.projects.approvalSettings, args: { projectId: "app-1" } },
    { kind: "mutation", ref: refs.permissions.grant, args: { memoryId: "verified-memory-2" } },
  ]);
});

test("an existing Auto permission is not granted again", async () => {
  const a = actions();
  a.returns(refs.screens.projects.approvalSettings, { active: true, canEnable: false, memoryId: null, permissionIds: ["permission-1"] });
  assert.equal(await a.setApprovals("app-1", "auto"), undefined);
  assert.equal(a.calls.length, 1);
});

test("Auto refuses missing settings, ambiguous eligibility, and missing scoped memory", async () => {
  for (const [settings, message] of [
    [null, "This project has no recovery permission settings."],
    [{ active: false, canEnable: false, memoryId: "memory-1", permissionIds: [], reason: "Several recoveries qualify. Choose one from its live case." }, "Several recoveries qualify. Choose one from its live case."],
    [{ active: false, canEnable: true, memoryId: null, permissionIds: [], reason: "The verified recovery is no longer available." }, "The verified recovery is no longer available."],
  ]) {
    const a = actions();
    a.returns(refs.screens.projects.approvalSettings, settings);
    await assert.rejects(a.setApprovals("app-1", "auto"), { message });
    assert.equal(a.calls.length, 1);
  }
});

test("switching to You revokes only the project's returned active permission ids", async () => {
  const a = actions();
  a.returns(refs.screens.projects.approvalSettings, { active: true, canEnable: false, memoryId: null, permissionIds: ["permission-1", "permission-2"] });
  a.returns(refs.permissions.revoke, undefined);
  assert.equal(await a.setApprovals("app-1", "you"), undefined);
  assert.deepEqual(a.calls, [
    { kind: "query", ref: refs.screens.projects.approvalSettings, args: { projectId: "app-1" } },
    { kind: "mutation", ref: refs.permissions.revoke, args: { permissionId: "permission-1" } },
    { kind: "mutation", ref: refs.permissions.revoke, args: { permissionId: "permission-2" } },
  ]);
  a.returns(refs.screens.projects.approvalSettings, { active: false, permissionIds: [] });
  await a.setApprovals("app-1", "you");
  assert.equal(a.calls.length, 4);
});

test("permission query, grant, and revoke failures keep their readable backend reasons", async () => {
  const a = actions();
  a.on(refs.screens.projects.approvalSettings, () => { throw new Error("Could not find public function screens/projects:approvalSettings"); });
  await assert.rejects(a.setApprovals("app-1", "auto"), /backend has not been updated/);
  a.returns(refs.screens.projects.approvalSettings, { active: false, canEnable: true, memoryId: "memory-1", permissionIds: [] });
  a.on(refs.permissions.grant, () => { throw new Error("This recovery memory has no app revision to pin the permission to."); });
  await assert.rejects(a.setApprovals("app-1", "auto"), { message: "This recovery memory has no app revision to pin the permission to." });
  a.returns(refs.screens.projects.approvalSettings, { active: true, permissionIds: ["permission-1"] });
  a.on(refs.permissions.revoke, () => { throw new Error("This permission has already ended."); });
  await assert.rejects(a.setApprovals("app-1", "you"), { message: "This permission has already ended." });
});

test("a star is stored on the case through the backend, and a refusal reads in plain words", async () => {
  const a = actions();
  a.returns(refs.cases.setStarred, null);
  await a.setStarred("case-1", true);
  await a.setStarred("case-1", false);
  assert.deepEqual(a.calls, [
    { kind: "mutation", ref: refs.cases.setStarred, args: { caseId: "case-1", starred: true } },
    { kind: "mutation", ref: refs.cases.setStarred, args: { caseId: "case-1", starred: false } },
  ]);
  a.on(refs.cases.setStarred, () => { throw Object.assign(new Error("ConvexError"), { data: "That project is not available on this account." }); });
  await assert.rejects(a.setStarred("case-2", true), { message: "That project is not available on this account." });
});

test("disconnected actions never fabricate a successful change", async () => {
  const a = actions();
  a.disconnect();
  await assert.rejects(a.approveFix("case-1", "repair"), /backend URL is not configured/);
  await assert.rejects(a.stopEnactment("case-1"), /backend URL is not configured/);
  await assert.rejects(a.setApprovals("app-1", "auto"), /backend URL is not configured/);
  assert.deepEqual(await a.mergePullRequest("case-1", "shown-head"), { ok: false, reason: "The backend URL is not configured." });
  await assert.rejects(a.setStarred("case-1", true), /backend URL is not configured/);
  assert.deepEqual(a.calls, []);
});
