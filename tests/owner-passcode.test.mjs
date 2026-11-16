import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const refusal = "That owner passcode is incorrect. Try again.";
const readable = (error) => error.data ?? error.message;

function owner({ stored, configured = true, failStorage = false } = {}) {
  let value = stored;
  const api = load("../data/live/ownerPasscode.ts", {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    "react-native": { Platform: { OS: "ios" } },
    "expo-secure-store": {
      getItemAsync: async () => value ?? null,
      setItemAsync: async (_key, next) => { if (failStorage) throw new Error("Storage unavailable"); value = next; },
      deleteItemAsync: async () => { value = undefined; },
    },
    "../../convex/_generated/api": { api: { ownerPasscode: { status: "ownerPasscode:status" } } },
    "./client": { errorMessage: readable, requireLiveClient: () => ({ query: async () => ({ configured }) }) },
  });
  return { ...api, stored: () => value };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("unclaimed decisions keep the rollout behavior without prompting", async () => {
  const o = owner({ configured: false });
  assert.equal(await o.withOwnerPasscode(async (passcode) => passcode ?? "unclaimed"), "unclaimed");
  assert.equal(o.useOwnerPasscodePrompt(), null);
});

test("the first protected decision waits for the owner and remembers the passcode", async () => {
  const o = owner();
  const calls = [];
  const decision = o.withOwnerPasscode(async (passcode) => { calls.push(passcode); return "approved"; });
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(o.useOwnerPasscodePrompt().busy, false);
  await o.submitOwnerPasscode("local-fixture-passcode");
  assert.equal(await decision, "approved");
  assert.deepEqual(calls, ["local-fixture-passcode"]);
  assert.equal(o.stored(), "local-fixture-passcode");
  await o.withOwnerPasscode(async (passcode) => { calls.push(passcode); });
  assert.equal(calls.length, 2);
  assert.equal(o.useOwnerPasscodePrompt(), null);
});

test("a wrong passcode shows the backend sentence and can be corrected in place", async () => {
  const o = owner();
  const decision = o.withOwnerPasscode(async (passcode) => {
    if (passcode !== "local-fixture-passcode") throw { data: refusal };
    return "approved";
  });
  await flush();
  await o.submitOwnerPasscode("wrong-fixture-passcode");
  assert.equal(o.useOwnerPasscodePrompt().error, refusal);
  assert.equal(o.stored(), undefined);
  await o.submitOwnerPasscode("local-fixture-passcode");
  assert.equal(await decision, "approved");
  assert.equal(o.useOwnerPasscodePrompt(), null);
});

test("a stale saved passcode is forgotten and re-entry recovers", async () => {
  const o = owner({ stored: "old-fixture-passcode" });
  const decision = o.withOwnerPasscode(async (passcode) => {
    if (passcode !== "new-fixture-passcode") throw { data: refusal };
    return true;
  });
  await flush();
  assert.equal(o.useOwnerPasscodePrompt().error, refusal);
  assert.equal(o.stored(), undefined);
  await o.submitOwnerPasscode("new-fixture-passcode");
  assert.equal(await decision, true);
});

test("cancel and unavailable device storage never run the owner decision", async () => {
  for (const failStorage of [false, true]) {
    const o = owner({ failStorage });
    let changed = false;
    const decision = o.withOwnerPasscode(async () => { changed = true; });
    const rejected = assert.rejects(decision, /cancelled/);
    await flush();
    if (failStorage) {
      await o.submitOwnerPasscode("local-fixture-passcode");
      assert.match(o.useOwnerPasscodePrompt().error, /could not save/);
    }
    o.cancelOwnerPasscode();
    await rejected;
    assert.equal(changed, false);
  }
});

test("business refusals are not retried as passcode failures", async () => {
  const o = owner({ stored: "local-fixture-passcode" });
  await assert.rejects(o.withOwnerPasscode(async () => { throw new Error("The proposal changed."); }), /proposal changed/);
  assert.equal(o.useOwnerPasscodePrompt(), null);
});

test("live approve, stop, merge, grant and revoke forward the supplied passcode", async () => {
  const calls = [];
  let active = false;
  const refs = { fixes: { forCase: "fixes" }, decisions: { approve: "approve" }, pullRequests: { merge: "merge" }, screens: { projects: { approvalSettings: "settings" } }, permissions: { grant: "grant", revoke: "revoke" } };
  const client = {
    query: async (ref) => ref === "fixes" ? { proposalId: "proposal", version: 1, fixes: [{ key: "fix" }] } : { active, canEnable: true, memoryId: "memory", permissionIds: ["permission"] },
    mutation: async (ref, args) => { calls.push([ref, args]); return { stopped: true }; },
    action: async (ref, args) => { calls.push([ref, args]); return { outcome: "merged" }; },
  };
  const a = load("../data/live/actions.ts", {
    "convex/server": { makeFunctionReference: (ref) => ref },
    "../../convex/_generated/api": { api: refs },
    "./client": { errorMessage: readable, requireLiveClient: () => client },
  });
  await a.approveFix("case", "fix", "fixture-passcode");
  await a.stopEnactment("case", "fixture-passcode");
  await a.mergePullRequest("case", "head", "fixture-passcode");
  await a.setApprovals("app", "auto", "fixture-passcode");
  active = true;
  await a.setApprovals("app", "you", "fixture-passcode");
  assert.deepEqual(calls.map(([ref, args]) => [ref, args.passcode]), ["approve", "decisions:stop", "merge", "grant", "revoke"].map((ref) => [ref, "fixture-passcode"]));
});

test("Dev Approve and Decline use the device's stored passcode", async () => {
  const calls = [];
  const api = { dev: new Proxy({}, { get: (_target, key) => key }), decisions: { approve: "approve", decline: "decline" } };
  const { useDevActions } = load("../components/dev/useDevActions.ts", {
    "convex/react": { useAction: () => () => {}, useMutation: (ref) => async (args) => { calls.push([ref, args]); } },
    react: { useState: () => [null, () => {}] },
    "../../convex/_generated/api": { api },
    "../../data/live/ownerPasscode": { getStoredOwnerPasscode: async () => "fixture-passcode" },
  });
  const dev = useDevActions();
  const proposal = { _id: "proposal", version: 3, optionKey: "fix" };
  await dev.decide("approve", proposal);
  await dev.decide("decline", proposal);
  assert.deepEqual(calls, [
    ["approve", { proposalId: "proposal", version: 3, optionKey: "fix", passcode: "fixture-passcode" }],
    ["decline", { proposalId: "proposal", version: 3, passcode: "fixture-passcode" }],
  ]);
});
