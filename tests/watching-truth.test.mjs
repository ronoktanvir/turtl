import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader } from "./fixtures/convex-memory.mjs";

// What "What turtl is watching" says must be true now: a check that has not run is not counted as failing, and a
// check whose break was declined is not shown as passing.

const { watchingSummary } = createLoader({
  "react-native": {},
  "expo-router": {},
  "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "Fragment" },
  "components/onboarding/Glyph": {},
  "data/overview": {},
  data: {},
  "data/index": {},
  theme: {},
  "components/ui": {},
})("components/project/Watching.tsx");

const check = (state) => ({ id: state + Math.random(), kind: "journey", name: "Book", state });

test("a check that has not run yet is counted apart, never as not passing", () => {
  assert.equal(watchingSummary([check("waiting")]), "1 check, not run yet");
  assert.equal(watchingSummary([check("waiting"), check("waiting")]), "2 checks, not run yet");
  assert.equal(watchingSummary([check("passing"), check("waiting")]), "1 check passing, 1 not run yet");
  assert.equal(watchingSummary([check("passing"), check("failing"), check("waiting")]), "1 of 2 checks passing, 1 not run yet");
  assert.equal(watchingSummary([check("passing"), check("passing")]), "All 2 checks passing");
  assert.equal(watchingSummary([check("failing")]), "0 of 1 checks passing");
});

function overviewQuery(cases, journey) {
  return createLoader({
    // The builders in convex/functions.ts ask the demo's own gate first; this test is about what the screen says.
    "convex/access": { visibleApp: async (ctx, appId) => await ctx.db.get(appId), accessEnforced: () => false, visibleApps: async () => [], refuseDemoWithAccounts: async () => {}, refuseDemoWithAccountsInAction: async () => {} },
    "convex/onboarding/records": { latestInspection: async () => null, preparationFor: async () => null },
  })("convex/screens/overview.ts").forProject.handler({
    db: {
      normalizeId: (_table, id) => id,
      get: async (id) => (id === "app1" ? { _id: "app1", name: "Practice" } : null),
      query: (table) => ({
        withIndex: () => ({
          take: async () => (table === "journeys" ? [journey] : []),
          order: () => ({ first: async () => (table === "cases" ? cases[0] ?? null : null) }),
        }),
        order: () => ({ take: async () => [] }),
      }),
    },
  }, { projectId: "app1" });
}

test("a check whose break was declined or left unresolved stays failing until it passes again", async () => {
  const journey = { _id: "j1", name: "Book an appointment", lastPassedAt: 1_000 };
  for (const status of ["declined", "unresolved"]) {
    const after = await overviewQuery([{ _id: "c1", _creationTime: 2_000, status }], journey);
    assert.equal(after.checks[0].state, "failing", status);
    const passedSince = await overviewQuery([{ _id: "c1", _creationTime: 2_000, status }], { ...journey, lastPassedAt: 3_000 });
    assert.equal(passedSince.checks[0].state, "passing", status + ", then passed again");
  }
  assert.equal((await overviewQuery([{ _id: "c1", _creationTime: 2_000, status: "investigating" }], journey)).checks[0].state, "failing");
  assert.equal((await overviewQuery([{ _id: "c1", _creationTime: 2_000, status: "restored" }], journey)).checks[0].state, "passing");
});

test("a broken practice app is not said to have users affected", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const ui = read("components/ui/index.tsx");
  assert.match(ui, /return practice && health === "affected" \? "Practice app broken" : healthWord\[health\];/);
  assert.match(read("app/projects.tsx"), /<HealthWord health=\{p\.health\} practice=\{!!p\.practice\} \/>/);
  assert.match(read("app/project/[projectId]/index.tsx"), /<HealthWord health=\{shown\} practice=\{!!project\.practice\}/);
  assert.match(read("components/fix/CasePage.tsx"), /<HealthWord health=\{c\.health\} practice=\{practice\}/);
});

test("an empty repository picker fits both a person who can choose more and one who can only read", () => {
  const { emptyPicker } = createLoader({
    react: {}, "react-native": {}, "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "Fragment" },
    "data/github": {}, "data/github/index": {}, theme: {}, "components/ui": {}, "components/github/open": {},
  })("components/github/ConnectGithub.tsx");
  assert.equal(emptyPicker(2), "turtl can't add any of your repositories yet. Below is why for each one, and what would change it.");
  assert.match(emptyPicker(0), /If you can change their settings on GitHub, choose some there, then come back\. If not, ask whoever can\.$/);
  assert.doesNotMatch(emptyPicker(2), /Choose some on GitHub/);
});

test("an empty Fix list with a check still failing says so, why no issue is open, and what to do", () => {
  const { stillBroken } = createLoader({
    "react-native": {}, "expo-router": {}, "react-native-safe-area-context": {}, "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "Fragment" },
    data: {}, "data/index": {}, "data/overview": {}, "data/overview/index": {}, theme: { labels: { features: "Features" } }, "components/ui": {}, "components/project/Watching": {},
  })("components/project/NothingOpen.tsx");
  const failing = { id: "j1", kind: "journey", name: "Book an appointment", state: "failing", closedAs: "declined" };
  assert.deepEqual(stillBroken([failing], true), {
    empty: "Book an appointment: not passing.",
    note: "No issue is open for it, because the last one closed when its fixes were declined. Put it back from the Break it tile on the project, then break it again if you like.",
  });
  assert.equal(stillBroken([{ ...failing, closedAs: "unresolved" }], false).note, "No issue is open for it, because the last one closed when turtl could not fix it. turtl opens a new one if the check passes and then fails again, and a customer's report opens one too.");
  assert.equal(stillBroken([{ ...failing, closedAs: undefined }], false), null, "failing with an issue open: the list is not empty");
  assert.equal(stillBroken([{ ...failing, state: "passing", closedAs: undefined }], false), null);
  assert.equal(stillBroken(undefined, false), null);
});

test("the overview says how a failing check's last issue ended", async () => {
  const journey = { _id: "j1", name: "Book an appointment", lastPassedAt: 1_000 };
  assert.equal((await overviewQuery([{ _id: "c1", _creationTime: 2_000, status: "declined" }], journey)).checks[0].closedAs, "declined");
  assert.equal((await overviewQuery([{ _id: "c1", _creationTime: 2_000, status: "unresolved" }], journey)).checks[0].closedAs, "unresolved");
  assert.equal("closedAs" in (await overviewQuery([{ _id: "c1", _creationTime: 2_000, status: "investigating" }], journey)).checks[0], false);
});
