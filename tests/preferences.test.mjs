import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { mapCaseDetail } from "../data/live/caseMapping.ts";

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
};

function actions() {
  const calls = [];
  const handlers = new Map();
  const client = Object.fromEntries(["query", "mutation", "action"].map((kind) => [kind, async (ref, args) => {
    calls.push({ kind, ref, args });
    assert.ok(handlers.has(ref), `Unexpected backend call: ${ref}`);
    return handlers.get(ref)(args);
  }]));
  const exports = load("../data/live/actions.ts", {
    "convex/server": { makeFunctionReference: (name) => name },
    "../../convex/_generated/api": { api: refs },
    "./client": { errorMessage, requireLiveClient: () => client },
  });
  return { ...exports, calls, on: (ref, handler) => handlers.set(ref, handler), returns: (ref, value) => handlers.set(ref, () => value) };
}

const proposal = { proposalId: "proposal-7", version: 7, fixes: [{ key: "recovery", recommended: true }, { key: "repair", recommended: false }] };

test("preference writes call the learning functions with the owner passcode", async () => {
  const a = actions();
  a.returns("learning/preferences:add", { id: "pref-1" });
  a.returns("learning/preferences:remove", null);
  a.returns("learning/preferences:confirm", { id: "pref-2" });
  a.returns("learning/preferences:dismiss", null);
  await a.addPreference("app-1", "  Keep checkout up  ", "secret-pass");
  await a.removePreference("pref-1", "secret-pass");
  await a.confirmPreference("suggestion-1", undefined, "secret-pass");
  await a.confirmPreference("suggestion-2", " Never restart active jobs. ", "secret-pass");
  await a.dismissPreference("suggestion-3", "secret-pass");
  await a.addPreference("app-1", "Keep checkout up");
  assert.deepEqual(a.calls, [
    { kind: "mutation", ref: "learning/preferences:add", args: { projectId: "app-1", statement: "Keep checkout up", passcode: "secret-pass" } },
    { kind: "mutation", ref: "learning/preferences:remove", args: { preferenceId: "pref-1", passcode: "secret-pass" } },
    { kind: "mutation", ref: "learning/preferences:confirm", args: { suggestionId: "suggestion-1", passcode: "secret-pass" } },
    { kind: "mutation", ref: "learning/preferences:confirm", args: { suggestionId: "suggestion-2", statement: "Never restart active jobs.", passcode: "secret-pass" } },
    { kind: "mutation", ref: "learning/preferences:dismiss", args: { suggestionId: "suggestion-3", passcode: "secret-pass" } },
    { kind: "mutation", ref: "learning/preferences:add", args: { projectId: "app-1", statement: "Keep checkout up" } },
  ]);
});

test("an empty preference is refused before any backend call, and backend refusals stay readable", async () => {
  const a = actions();
  await assert.rejects(a.addPreference("app-1", "   ", "secret-pass"), /Write what matters to you/);
  assert.equal(a.calls.length, 0);
  a.on("learning/preferences:remove", () => { throw new Error("[CONVEX M(learning/preferences:remove)] Server Error\nUncaught Error: That owner passcode is incorrect. Try again.\n    at remove"); });
  await assert.rejects(a.removePreference("pref-1", "wrong"), { message: "That owner passcode is incorrect. Try again." });
  a.on("learning/preferences:dismiss", () => { throw new Error("Could not find public function learning/preferences:dismiss"); });
  await assert.rejects(a.dismissPreference("suggestion-1"), /backend has not been updated/);
});

test("Decline reads the latest proposal and sends its id, version, passcode and a trimmed note", async () => {
  const a = actions();
  a.returns(refs.fixes.forCase, proposal);
  a.returns("decisions:decline", null);
  await a.declineFixes("case-1", "secret-pass", "  Keep booking up  ");
  await a.declineFixes("case-1", undefined, "   ");
  assert.deepEqual(a.calls, [
    { kind: "query", ref: refs.fixes.forCase, args: { caseId: "case-1" } },
    { kind: "mutation", ref: "decisions:decline", args: { proposalId: "proposal-7", version: 7, passcode: "secret-pass", note: "Keep booking up" } },
    { kind: "query", ref: refs.fixes.forCase, args: { caseId: "case-1" } },
    { kind: "mutation", ref: "decisions:decline", args: { proposalId: "proposal-7", version: 7 } },
  ]);
});

test("Decline refuses when there is no pending proposal", async () => {
  for (const current of [null, { ...proposal, proposalId: null }, { ...proposal, fixes: [] }]) {
    const a = actions();
    a.returns(refs.fixes.forCase, current);
    await assert.rejects(a.declineFixes("case-1", "secret-pass"), /No proposed fix is available to decline/);
    assert.equal(a.calls.length, 1);
  }
});

test("Approve passes a note only when it has text", async () => {
  const a = actions();
  a.returns(refs.fixes.forCase, proposal);
  a.returns(refs.decisions.approve, { actionId: "action-1" });
  await a.approveFix("case-1", "repair", "secret-pass", "  Cheaper to run  ");
  await a.approveFix("case-1", "repair", "secret-pass", "   ");
  await a.approveFix("case-1", "repair", undefined, undefined);
  assert.deepEqual(a.calls.filter((call) => call.kind === "mutation").map((call) => call.args), [
    { proposalId: "proposal-7", version: 7, optionKey: "repair", passcode: "secret-pass", note: "Cheaper to run" },
    { proposalId: "proposal-7", version: 7, optionKey: "repair", passcode: "secret-pass" },
    { proposalId: "proposal-7", version: 7, optionKey: "repair" },
  ]);
});

test("owner wrappers run every preference and decline write behind the owner passcode", async () => {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  const owner = load("../data/live/ownerActions.ts", {
    "./actions": Object.fromEntries(["approveFix", "declineFixes", "addPreference", "removePreference", "confirmPreference", "dismissPreference", "stopEnactment", "setApprovals", "mergePullRequest"].map((name) => [name, record(name)])),
    "./ownerPasscode": { withOwnerPasscode: (work) => { calls.push(["passcode"]); return work("owner-pass"); } },
  });
  await owner.approveFix("case-1", "repair", "Cheaper");
  await owner.declineFixes("case-1", "Keep booking up");
  await owner.addPreference("app-1", "Keep checkout up");
  await owner.removePreference("app-1", "pref-1");
  await owner.confirmPreference("app-1", "suggestion-1", "Edited");
  await owner.dismissPreference("app-1", "suggestion-2");
  assert.deepEqual(calls, [
    ["passcode"], ["approveFix", "case-1", "repair", "owner-pass", "Cheaper"],
    ["passcode"], ["declineFixes", "case-1", "owner-pass", "Keep booking up"],
    ["passcode"], ["addPreference", "app-1", "Keep checkout up", "owner-pass"],
    ["passcode"], ["removePreference", "pref-1", "owner-pass"],
    ["passcode"], ["confirmPreference", "suggestion-1", "Edited", "owner-pass"],
    ["passcode"], ["dismissPreference", "suggestion-2", "owner-pass"],
  ]);
});

test("live mapping keeps the preferences and past decisions that shaped a fix", () => {
  const fix = {
    key: "recover", title: "Turn off recommendations", kind: "recovery", recommended: true, why: [{ text: "Booking need not wait." }],
    whatChanges: "Disables suggestions.", whatMightBeLost: "Suggestions.", howChecked: "Run the booking check.",
    preferences: [{ id: "pref-1", statement: "Keep booking up." }], pastDecisions: "You turned this down twice before.",
  };
  const cards = { case: { _id: "case-1", _creationTime: 1, appId: "app-1", title: "Booking failed", kind: "outage", status: "waiting_for_owner" }, journey: null, steps: [], executeAttempts: [], evidence: [], proposal: null, action: null, verifications: [], agentRuns: [] };
  const detail = mapCaseDetail(cards, { proposalId: "p", version: 1, chosenKey: null, fixes: [fix] }, null, [], 1);
  assert.deepEqual(detail.fixes[0].preferences, [{ id: "pref-1", statement: "Keep booking up." }]);
  assert.equal(detail.fixes[0].pastDecisions, "You turned this down twice before.");
});

function exampleStore() {
  const prefs = load("../data/example/preferences.ts", {});
  const timing = load("../data/example/timing.ts", {});
  const fix = (key, recommended) => ({ key, title: key, kind: "repair", recommended, why: [{ text: "Because." }], whatChanges: "x", whatMightBeLost: "y", howChecked: "z" });
  const seed = { id: "case-1", projectId: "listener-ladder", type: "fix", number: 1, title: "Slow answers", category: "outage", status: "needs_approval", health: "affected", happenedAt: 1, summary: "s", overview: [], citations: [], logs: [], code: [], screenshots: [], fixes: [fix("a", true), fix("b", false)] };
  const store = load("../data/example/store.ts", {
    "./preferences": prefs,
    "./timing": timing,
    "./content": {
      afterShots: () => [], caseReplies: { default: ["Noted."] }, caseSeeds: [seed], headChangesOnce: [], learnedFor: () => "", networks: {},
      planFor: () => [], projectSeeds: [{ id: "listener-ladder", name: "Listener Ladder", approvals: "you" }], proposals: {}, pullRequestFor: () => ({}),
    },
  });
  return { prefs, store };
}

test("example preferences round-trip through add, remove, confirm and dismiss", async () => {
  const { store } = exampleStore();
  const start = store.getPreferences("listener-ladder");
  assert.deepEqual(start.preferences.map((p) => p.statement), ["Keep the answer flow the same, even if ranks take more work."]);
  assert.deepEqual(start.suggestions.map((s) => [s.statement, s.source]), [["Don't reset players' streaks.", "decision_note"]]);
  assert.equal(store.getPreferences("missing"), null);

  const before = store.getVersion();
  await store.addPreference("listener-ladder", "  Keep checkout up ");
  assert.ok(store.getVersion() > before);
  const added = store.getPreferences("listener-ladder").preferences.at(-1);
  assert.deepEqual([added.statement, added.source], ["Keep checkout up", "settings"]);
  await assert.rejects(store.addPreference("listener-ladder", "  "), /Write what matters to you/);

  await store.removePreference("listener-ladder", added.id);
  assert.ok(!store.getPreferences("listener-ladder").preferences.some((p) => p.id === added.id));

  await store.confirmPreference("listener-ladder", "suggestion-streaks", "Never reset streaks.");
  let now = store.getPreferences("listener-ladder");
  assert.equal(now.suggestions.length, 0);
  assert.deepEqual([now.preferences.at(-1).statement, now.preferences.at(-1).source], ["Never reset streaks.", "decision_note"]);
  await assert.rejects(store.dismissPreference("listener-ladder", "suggestion-streaks"), /already handled/);
});

test("example chat proposes a preference for a lasting wish, and saving or dismissing updates the message", async () => {
  const { store } = exampleStore();
  const scope = { kind: "case", caseId: "case-1" };
  await store.sendChat(scope, "Please don't restart active games.");
  let reply = store.chatMessages(scope).at(-1);
  assert.equal(reply.role, "turtl");
  assert.equal(reply.proposedPreference.statement, "Don't restart active games.");
  assert.equal(reply.proposedPreference.status, "pending");
  const suggestion = store.getPreferences("listener-ladder").suggestions.find((s) => s.id === reply.proposedPreference.id);
  assert.equal(suggestion.source, "chat");

  await store.confirmPreference("listener-ladder", reply.proposedPreference.id);
  reply = store.chatMessages(scope).at(-1);
  assert.equal(reply.proposedPreference.status, "saved");
  assert.ok(store.getPreferences("listener-ladder").preferences.some((p) => p.statement === "Don't restart active games." && p.source === "chat"));

  await store.sendChat(scope, "I'd rather you always keep ranks visible.");
  reply = store.chatMessages(scope).at(-1);
  assert.equal(reply.proposedPreference.statement, "Always keep ranks visible.");
  await store.dismissPreference("listener-ladder", reply.proposedPreference.id);
  assert.equal(store.chatMessages(scope).at(-1).proposedPreference.status, "dismissed");

  await store.sendChat(scope, "What does the log say?");
  assert.equal(store.chatMessages(scope).at(-1).proposedPreference, undefined);
});

test("example decline closes the case and turns its note into a suggestion", async () => {
  const { store } = exampleStore();
  await store.declineFixes("case-1", "Keep the game playable");
  const declined = store.getCase("case-1");
  assert.equal(declined.status, "declined");
  assert.equal(declined.health, "clear");
  assert.deepEqual(store.listCases("listener-ladder", "fix"), []);
  const heard = store.getPreferences("listener-ladder").suggestions.at(-1);
  assert.deepEqual([heard.statement, heard.source], ["Keep the game playable.", "decision_note"]);
  await assert.rejects(store.declineFixes("case-1"), /already closed/);
});
