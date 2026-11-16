import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import * as values from "convex/values";

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  });
  const module = { exports: {} };
  runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: path })(
    (name) => { assert.ok(name in imports, "Unexpected import: " + name); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// --- What a project with nothing open shows (RC-06) ---

const { overviewFromOnboarding } = load("../data/overview/fromOnboarding.ts", {});
const { onboardingSeeds } = load("../data/onboarding/content.ts", {});

test("the example build watches what a project's preparation registered, without its recovery hooks", () => {
  const now = Date.UTC(2026, 10, 15);
  const [guardian, orca] = onboardingSeeds(now);
  const watched = overviewFromOnboarding(guardian, null);
  assert.equal(watched.preparation, "done");
  assert.deepEqual(watched.checks.map((c) => [c.kind, c.name, c.state]), [
    ["health", "Health check", "passing"],
    ["journey", "A customer's transaction is scored", "passing"],
    ["flag", "rules_only_scoring", "passing"],
  ]);
  assert.ok(watched.checks.every((c) => c.lastPassedAt === guardian.checkedAt));
  assert.deepEqual(overviewFromOnboarding(orca, null), { checks: [], preparation: "in_progress", map: null });
  assert.deepEqual(overviewFromOnboarding(null, { parts: 3, groups: 1 }), { checks: [], preparation: "none", map: { parts: 3, groups: 1 } });
  const failing = overviewFromOnboarding({ ...guardian, checks: [{ ...guardian.checks[0], state: "no_response" }] }, null);
  assert.deepEqual(failing.checks.map((c) => [c.state, c.lastPassedAt]), [["failing", undefined]]);
});

// A small stand-in for ctx.db: withIndex filters on the equalities given, order and take as Convex does.
function fakeDb(tables) {
  const db = {
    normalizeId: (table, id) => (tables[table]?.some((row) => row._id === id) ? id : null),
    get: async (id) => Object.values(tables).flat().find((row) => row._id === id) ?? null,
    query: (table) => {
      let rows = [...(tables[table] ?? [])];
      const chain = {
        withIndex: (_name, build) => {
          const eqs = [];
          const q = { eq: (field, value) => { eqs.push([field, value]); return q; } };
          build(q);
          rows = rows.filter((row) => eqs.every(([field, value]) => row[field] === value));
          return chain;
        },
        order: (direction) => { if (direction === "desc") rows.reverse(); return chain; },
        first: async () => rows[0] ?? null,
        take: async (n) => { chain.taken = n; return rows.slice(0, n); },
      };
      db.reads.push({ table, chain });
      return chain;
    },
    reads: [],
  };
  return db;
}

function overviewQuery({ visible = true } = {}) {
  return load("../convex/screens/overview.ts", {
    "convex/values": values,
    "../_generated/server": { query: (definition) => definition },
    // The public builder, without its demo check (convex/functions.ts), which tests/access-rules.test.mjs covers.
    "../functions": { query: (definition) => definition },
    // The single-owner demo's read: another project's map of the same repository may stand in. With accounts on only the
    // caller's own projects' maps do (tests/access-rules.test.mjs, review finding 9).
    "../access": { visibleApp: async (ctx, appId) => (visible ? await ctx.db.get(appId) : null), accessEnforced: () => false, visibleApps: async () => [] },
    "../constants": { CLOSED_CASE_STATUSES: ["resolved", "declined", "unresolved"] },
    "../onboarding/records": {
      latestInspection: (ctx, appId) => ctx.db.query("onboardingInspections").withIndex("by_app", (q) => q.eq("appId", appId)).order("desc").first(),
      preparationFor: (ctx, appId) => ctx.db.query("onboardingPreparations").withIndex("by_app", (q) => q.eq("appId", appId)).first(),
    },
    "../onboarding/stage": load("../convex/onboarding/stage.ts", {}),
  }).forProject;
}

const tables = () => ({
  apps: [{ _id: "app1", name: "Bookings", repoUrl: "https://github.com/acme/bookings" }, { _id: "sample", name: "Sample", isSample: true }],
  journeys: [
    { _id: "j1", appId: "app1", name: "Book an appointment", lastPassedAt: 1000 },
    { _id: "j2", appId: "app1", name: "Pay for a booking" },
    { _id: "j3", appId: "app1", name: "Cancel a booking", lastPassedAt: 900 },
  ],
  cases: [
    { _id: "c1", appId: "app1", signature: "journey_failed:j3", status: "investigating" },
    { _id: "c0", appId: "app1", signature: "journey_failed:j1", status: "restored" },
  ],
  onboardingPreparations: [{
    _id: "p1", appId: "app1", neverBreak: [], mergedAt: 5,
    registration: { status: "done", checks: [
      { kind: "health", name: "Health check", url: "https://bookings.example/health", state: "works", detail: "", checkedAt: 2000 },
      { kind: "journey", name: "Book an appointment", url: "https://bookings.example/j", state: "works", detail: "", checkedAt: 2000, journeyId: "j1" },
      { kind: "readiness", name: "Readiness check", url: "https://bookings.example/ready", state: "failing", detail: "", checkedAt: 2000 },
      { kind: "recovery_hook", name: "Pause new work", url: "https://bookings.example/pause", state: "works", detail: "", checkedAt: 2000 },
    ] },
  }],
  onboardingInspections: [],
  codeNetworks: [{ _id: "n1", projectId: "other", repo: "acme/bookings", nodes: [1, 2, 3], clusters: [1] }],
});

test("the overview query lists each check with when it last passed, and finds the code map", async () => {
  const forProject = overviewQuery();
  const db = fakeDb(tables());
  const result = await forProject.handler({ db }, { projectId: "app1" });
  assert.deepEqual(result.checks.map((c) => [c.name, c.state, c.lastPassedAt]), [
    ["Book an appointment", "passing", 1000],
    ["Pay for a booking", "waiting", undefined],
    ["Cancel a booking", "failing", 900],
    ["Health check", "passing", 2000],
    ["Readiness check", "failing", undefined],
  ]);
  assert.equal(result.preparation, "done");
  assert.deepEqual(result.map, { parts: 3, groups: 1 });
  assert.ok(db.reads.some((r) => r.table === "journeys" && r.chain.taken === 50), "journeys are read with a bound");
  assert.ok(db.reads.some((r) => r.table === "codeNetworks" && r.chain.taken === 100), "the fallback search for a map is bounded");
  assert.ok(forProject.returns, "the query declares what it returns");
});

test("the overview query shows nothing for a project the caller cannot see, a sample, or an unknown id", async () => {
  assert.equal(await overviewQuery({ visible: false }).handler({ db: fakeDb(tables()) }, { projectId: "app1" }), null);
  assert.equal(await overviewQuery().handler({ db: fakeDb(tables()) }, { projectId: "sample" }), null);
  assert.equal(await overviewQuery().handler({ db: fakeDb(tables()) }, { projectId: "nope" }), null);
});

test("a project still being prepared says so, and one without a repository has no map", async () => {
  const t = tables();
  t.apps[0].repoUrl = undefined;
  t.journeys = [];
  t.onboardingPreparations = [{ _id: "p1", appId: "app1", neverBreak: [] }];
  t.onboardingInspections = [{ _id: "i1", appId: "app1", status: "running", items: [] }];
  assert.deepEqual(await overviewQuery().handler({ db: fakeDb(t) }, { projectId: "app1" }), { checks: [], preparation: "in_progress", map: null });
});

test("a project whose repository could not be read says so, rather than that turtl is still preparing it", async () => {
  const t = tables();
  t.journeys = [];
  t.onboardingPreparations = [{ _id: "p1", appId: "app1", neverBreak: [] }];
  t.onboardingInspections = [{ _id: "i1", appId: "app1", status: "failed", items: [] }];
  assert.equal((await overviewQuery().handler({ db: fakeDb(t) }, { projectId: "app1" })).preparation, "unreadable");
  const { readFileSync } = await import("node:fs");
  const watching = readFileSync(new URL("../components/project/Watching.tsx", import.meta.url), "utf8");
  assert.match(watching, /preparation === "unreadable" \? \(/);
  assert.match(watching, /turtl couldn't read this project's repository, so it is not watching anything yet\. Open Preparation/);
  const home = readFileSync(new URL("../app/project/[projectId]/index.tsx", import.meta.url), "utf8");
  assert.match(home, /const unreadable = onboarding\?\.stage === "inspection_failed";/);
  assert.match(home, /const shown = \(unreadable \|\| failing\) && project\?\.health === "clear" \? "needs_you" : project\?\.health \?\? "clear";/);
  assert.match(home, /<HealthWord health=\{shown\}/);
  assert.match(home, /const failing = !!overview\?\.checks\.some\(\(check\) => check\.state === "failing"\);/);
});

// --- The old case list and case screen are gone from store builds (RC-05) ---

function route(path, isStoreBuild) {
  const queried = [];
  const Redirect = function Redirect() { return null; };
  const exports = load(path, {
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" },
    "convex/react": { useQuery: (ref) => { queried.push(ref); return undefined; } },
    "expo-router": { Redirect, Link: "Link", useLocalSearchParams: () => ({ id: "c1" }) },
    react: { useEffect: () => {}, useRef: () => ({}), useState: (v) => [typeof v === "function" ? v() : v, () => {}] },
    "react-native": new Proxy({ StyleSheet: { create: (s) => s } }, { get: (target, key) => target[key] ?? String(key) }),
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "../convex/_generated/api": { api: { cases: { listWithSteps: "cases:listWithSteps" } } },
    "../../convex/_generated/api": { api: { cases: { cards: "cases:cards" } } },
    "../components/feed/CaseRow": { CaseRow: "CaseRow" },
    "../data/source": { isStoreBuild },
    "../../data/source": { isStoreBuild },
    ...Object.fromEntries(["cards", "CardPage", "CaseKindChip", "DecisionPanel", "PermissionPanel", "incident", "StatusBadge"].map((name) => ["../../components/feed/" + name, {}])),
  });
  return { element: exports.default(), queried, Redirect };
}

for (const path of ["../app/live.tsx", "../app/case/[id].tsx"]) {
  test(path.slice(3) + " sends a store build to Projects without drawing or querying, and stays in development builds", () => {
    const store = route(path, true);
    assert.equal(store.element.type, store.Redirect);
    assert.equal(store.element.props.href, "/projects");
    assert.deepEqual(store.queried, []);
    const dev = route(path, false);
    assert.notEqual(dev.element.type, dev.Redirect);
    assert.equal(typeof dev.element.type, "function");
  });
}

// --- Home keeps Ronok's design, and a new account starts on the first-run screen (TUR-72, RC-01) ---

test("Home's header shows the turtl logo, always the green one, with no health line under the title", () => {
  const home = source("../app/projects.tsx");
  // Ronok asked for the small logo with the name in it here, in place of the turtle on its own (2026-11-16).
  assert.match(home, /<Logo health="clear" width=\{[^}]+\} \/>/);
  assert.ok(!home.includes('<Turtle health="clear"'), "the lone header turtle is gone");
  assert.ok(!home.includes("home-health"));
  assert.ok(home.includes("<ProfileButton />"), "the profile picture is the accounts slice's: today's photo in the demo, the signed-in person's otherwise");
  assert.ok(!home.includes("ronok-avatar"), "Home itself no longer names the compiled-in photo");
});

test("an empty project list shows the first-run screen with one way to add a project", () => {
  const home = source("../app/projects.tsx");
  assert.ok(home.includes("projects?.length === 0 && <FirstRun"));
  assert.ok(!home.includes("No projects yet"));
  const firstRun = source("../components/project/FirstRun.tsx");
  assert.equal(firstRun.match(/<Button /g).length, 1);
  assert.ok(firstRun.includes('testID="first-run-add-project"'));
});

test("the root layout exports an error boundary, and unknown links have a screen", () => {
  assert.ok(source("../app/_layout.tsx").includes('export { ScreenError as ErrorBoundary } from "../components/ui/ScreenError";'));
  const boundary = source("../components/ui/ScreenError.tsx");
  for (const id of ["screen-error-retry", "screen-error-projects"]) assert.ok(boundary.includes(`testID="${id}"`));
  assert.ok(source("../app/+not-found.tsx").includes('testID="not-found-projects"'));
});
