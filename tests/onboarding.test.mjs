import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: path })(
    (name) => { assert.ok(name in imports, "Unexpected import: " + name); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

function exampleStore() {
  const added = [];
  const content = load("../data/onboarding/content.ts", {});
  const store = load("../data/onboarding/example.ts", {
    react: { useMemo: (make) => make(), useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    "../example/store": { addProjectSeed: (seed) => added.push(seed), listProjects: () => [{ id: "orca" }, { id: "guardian" }, ...added] },
    "./content": content,
  });
  return { ...store, added };
}

test("adding a project shows it on Home and reads it before asking what must never break", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const s = exampleStore();
  const { projectId } = await s.addProject({ repoUrl: "https://github.com/acme/booking-app.git", liveUrl: "https://booking.acme.dev", folders: [" apps/mobile/ ", ""] });
  assert.equal(projectId, "mobile");
  assert.deepEqual(s.added, [{ id: "mobile", name: "mobile", repoUrl: "https://github.com/acme/booking-app", productionUrl: "https://booking.acme.dev", approvals: "you" }]);
  let o = s.useOnboarding(projectId);
  assert.equal(o.stage, "inspecting");
  assert.deepEqual(o.folders, ["apps/mobile"]);
  mock.timers.tick(s.exampleTiming.inspect);
  o = s.useOnboarding(projectId);
  assert.equal(o.stage, "asking");
  assert.equal(o.inspection.items.length, 7);
  assert.ok(o.inspection.items.every((item) => item.status === "unknown" && item.files.length === 0), "nothing is claimed as found without reading the repository");
  assert.match(o.inspection.readNote, /has not read the repository/);
  await assert.rejects(s.addProject({ repoUrl: "https://github.com/acme/booking-app", folders: ["apps/mobile"] }), /already a project in turtl/);
  await assert.rejects(s.addProject({ repoUrl: "acme/booking-app" }), /GitHub address/);
  await assert.rejects(s.addProject({ repoUrl: "https://github.com/acme/other", liveUrl: "booking" }), /live app URL/);
  const second = await s.addProject({ repoUrl: "https://github.com/acme/booking-app" });
  assert.equal(second.projectId, "booking-app");
  assert.equal(s.useOnboarding("nothing-here"), null);
});

test("answers, one approval, checks, and a merge at the shown commit lead to what works now", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const s = exampleStore();
  const asking = s.useOnboarding("orca");
  assert.equal(asking.stage, "asking");
  await assert.rejects(s.approvePreparation("orca", asking.inspection.id), /nothing waiting for your approval/);
  await s.saveNeverBreak("orca", [...asking.neverBreak, { text: "  Agents stop when the owner presses Stop ", addCheck: true }]);
  const ready = s.useOnboarding("orca");
  assert.equal(ready.stage, "ready");
  assert.equal(ready.answered, true);
  assert.equal(ready.neverBreak.at(-1).text, "Agents stop when the owner presses Stop");
  assert.equal(ready.neverBreak.at(-1).suggested, false);
  await assert.rejects(s.approvePreparation("orca", "an-older-inspection"), /read the repository again/);
  await s.approvePreparation("orca", ready.inspection.id);
  assert.equal(s.useOnboarding("orca").stage, "opening");
  await assert.rejects(s.saveNeverBreak("orca", []), /already approved/);
  mock.timers.tick(s.exampleTiming.open);
  let o = s.useOnboarding("orca");
  assert.equal(o.stage, "pr_open");
  assert.equal(o.pullRequest.checks, "pending");
  assert.equal(o.pullRequest.mergeable, false);
  assert.deepEqual(await s.mergePreparation("orca", o.pullRequest.headSha), { ok: false, reason: "The checks have not passed yet." });
  mock.timers.tick(s.exampleTiming.checks);
  o = s.useOnboarding("orca");
  assert.equal(o.pullRequest.checks, "passing");
  assert.ok(o.pullRequest.checkRuns.every((run) => run.status === "passed"));
  const stale = await s.mergePreparation("orca", "0000000");
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /changed after you looked/);
  assert.equal(s.useOnboarding("orca").stage, "pr_open");
  assert.deepEqual(await s.mergePreparation("orca", o.pullRequest.headSha), { ok: true });
  o = s.useOnboarding("orca");
  assert.equal(o.stage, "registering");
  assert.equal(o.pullRequest.state, "merged");
  mock.timers.tick(s.exampleTiming.register);
  o = s.useOnboarding("orca");
  assert.equal(o.stage, "registered");
  const journeys = o.checks.filter((check) => check.kind === "journey").map((check) => check.name);
  assert.deepEqual(journeys, ["A team finishes a task and reports its result", "The owner can start a new task", "Agents stop when the owner presses Stop"]);
  assert.ok(o.checks.every((check) => check.url.startsWith("https://orca-teams.vercel.app/")));
  assert.deepEqual(await s.mergePreparation("orca", o.pullRequest.headSha), { ok: false, reason: "This pull request is already merged." });
  await s.checkLiveAgain("orca");
  assert.equal(s.useOnboarding("orca").stage, "registering");
  mock.timers.tick(s.exampleTiming.recheck);
  assert.equal(s.useOnboarding("orca").stage, "registered");
});

test("an added project that was never read cannot pretend a pull request was opened", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const s = exampleStore();
  const { projectId } = await s.addProject({ repoUrl: "https://github.com/acme/shop" });
  mock.timers.tick(s.exampleTiming.inspect);
  await s.saveNeverBreak(projectId, [{ text: "Customers can check out", addCheck: true }]);
  await s.approvePreparation(projectId, s.useOnboarding(projectId).inspection.id);
  mock.timers.tick(s.exampleTiming.open);
  const o = s.useOnboarding(projectId);
  assert.equal(o.stage, "opening_failed");
  assert.equal(o.pullRequest, undefined);
  assert.match(o.problem, /Nothing changed in your repository/);
});

test("the finished project keeps its report, merged pull request and working checks", () => {
  const s = exampleStore();
  const o = s.useOnboarding("guardian");
  assert.equal(o.stage, "registered");
  assert.equal(o.pullRequest.state, "merged");
  assert.ok(o.inspection.items.filter((item) => item.status === "found").every((item) => item.files.length > 0));
  assert.ok(o.checks.some((check) => check.kind === "health" && check.state === "works"));
  assert.ok(o.checks.some((check) => check.kind === "journey" && check.name === "A customer's transaction is scored" && check.registered));
  assert.equal(o.checks.filter((check) => check.kind === "flag" && check.registered).length, 1);
});

const { errorMessage } = load("../data/live/client.ts", {
  "convex/react": { ConvexReactClient: class {} },
  "convex/server": {},
  react: {},
  "../source": { isLiveData: false },
});

const refs = Object.fromEntries(["forProject", "add", "saveAnswers", "approve", "merge", "refresh", "inspectAgain", "checkAgain"].map((name) => [name, "onboarding/projects:" + name]));

function liveHooks({ unclaimed = false } = {}) {
  const passcode = unclaimed ? undefined : "local-fixture-passcode";
  const calls = [];
  const owner = [];
  const handlers = new Map();
  const client = Object.fromEntries(["query", "mutation", "action"].map((kind) => [kind, async (ref, args) => {
    calls.push({ kind, ref, args });
    assert.ok(handlers.has(ref), "Unexpected backend call: " + ref);
    return handlers.get(ref)(args);
  }]));
  const hooks = load("../data/onboarding/live.ts", {
    "../../convex/_generated/api": { api: { onboarding: { projects: refs } } },
    "../live/client": {
      errorMessage,
      requireLiveClient: () => client,
      useLiveQuery: (ref, args) => { calls.push({ kind: "watch", ref, args }); return null; },
    },
    "../live/ownerPasscode": { withOwnerPasscode: async (work) => { owner.push(calls.length); return work(passcode); } },
  });
  return { ...hooks, calls, owner, on: (ref, handler) => handlers.set(ref, handler), returns: (ref, value) => handlers.set(ref, () => value) };
}

test("live onboarding reads the project's onboarding without a passcode", () => {
  const l = liveHooks();
  assert.equal(l.useOnboarding("project-1"), null);
  assert.deepEqual(l.calls, [{ kind: "watch", ref: refs.forProject, args: { projectId: "project-1" } }]);
  assert.deepEqual(l.owner, []);
});

test("adding a project, approving, reading again and checking again go through the owner passcode", async () => {
  const l = liveHooks();
  l.returns(refs.add, { projectId: "project-9" });
  l.returns(refs.approve, null);
  l.returns(refs.inspectAgain, null);
  l.returns(refs.checkAgain, null);
  assert.deepEqual(await l.addProject({ repoUrl: " https://github.com/acme/shop ", liveUrl: "https://shop.acme.dev", folders: ["apps/mobile", " "] }), { projectId: "project-9" });
  await l.addProject({ repoUrl: "https://github.com/acme/shop", liveUrl: " ", folders: [] });
  assert.equal(await l.approvePreparation("project-9", "inspection-3"), undefined);
  assert.equal(await l.inspectAgain("project-9"), undefined);
  assert.equal(await l.checkLiveAgain("project-9"), undefined);
  assert.deepEqual(l.calls, [
    { kind: "mutation", ref: refs.add, args: { repoUrl: "https://github.com/acme/shop", liveUrl: "https://shop.acme.dev", folders: ["apps/mobile"], passcode: "local-fixture-passcode" } },
    { kind: "mutation", ref: refs.add, args: { repoUrl: "https://github.com/acme/shop", passcode: "local-fixture-passcode" } },
    { kind: "mutation", ref: refs.approve, args: { projectId: "project-9", inspectionId: "inspection-3", passcode: "local-fixture-passcode" } },
    { kind: "mutation", ref: refs.inspectAgain, args: { projectId: "project-9", passcode: "local-fixture-passcode" } },
    { kind: "mutation", ref: refs.checkAgain, args: { projectId: "project-9", passcode: "local-fixture-passcode" } },
  ]);
  assert.deepEqual(l.owner, [0, 1, 2, 3, 4], "each owner decision waited for the passcode before calling the backend");
});

test("an unclaimed backend gets no passcode argument", async () => {
  const l = liveHooks({ unclaimed: true });
  l.returns(refs.approve, null);
  await l.approvePreparation("project-9", "inspection-3");
  assert.deepEqual(l.calls[0].args, { projectId: "project-9", inspectionId: "inspection-3" });
});

test("saving answers and refreshing the pull request are not owner decisions", async () => {
  const l = liveHooks();
  l.returns(refs.saveAnswers, null);
  l.returns(refs.refresh, null);
  const answers = [{ id: "n1", text: "Customers can check out", suggested: true, addCheck: true }, { text: "Receipts arrive", addCheck: false }];
  assert.equal(await l.saveNeverBreak("project-9", answers), undefined);
  assert.equal(await l.refreshPreparation("project-9"), undefined);
  assert.deepEqual(l.calls, [
    { kind: "mutation", ref: refs.saveAnswers, args: { projectId: "project-9", answers } },
    { kind: "action", ref: refs.refresh, args: { projectId: "project-9" } },
  ]);
  assert.deepEqual(l.owner, []);
});

test("merge sends the commit the owner saw and returns refusals instead of throwing", async () => {
  const l = liveHooks();
  l.returns(refs.merge, { ok: true });
  assert.deepEqual(await l.mergePreparation("project-9", "4e9b0d1"), { ok: true });
  assert.deepEqual(l.calls, [{ kind: "action", ref: refs.merge, args: { projectId: "project-9", headSha: "4e9b0d1", passcode: "local-fixture-passcode" } }]);
  assert.deepEqual(l.owner, [0]);
  l.returns(refs.merge, { ok: false, reason: "New commits arrived after you looked." });
  assert.deepEqual(await l.mergePreparation("project-9", "4e9b0d1"), { ok: false, reason: "New commits arrived after you looked." });
  l.returns(refs.merge, { ok: false, reason: "That owner passcode is incorrect. Try again." });
  assert.deepEqual(await l.mergePreparation("project-9", "4e9b0d1"), { ok: false, reason: "That owner passcode is incorrect. Try again." });
  l.on(refs.merge, () => { throw new Error("[CONVEX A(onboarding/projects:merge)] Server Error\nUncaught Error: Checks are not passing.\n    at merge (projects.ts:170)"); });
  assert.deepEqual(await l.mergePreparation("project-9", "4e9b0d1"), { ok: false, reason: "Checks are not passing." });
});

test("backend refusals reach the screen as plain sentences", async () => {
  const l = liveHooks();
  l.on(refs.add, () => { throw { data: "acme/shop is already a project in turtl." }; });
  await assert.rejects(l.addProject({ repoUrl: "https://github.com/acme/shop" }), { message: "acme/shop is already a project in turtl." });
  l.on(refs.saveAnswers, () => { throw new Error("Could not find public function onboarding/projects:saveAnswers"); });
  await assert.rejects(l.saveNeverBreak("project-9", []), /backend has not been updated/);
});
