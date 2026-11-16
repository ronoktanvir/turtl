import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path).exports;
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  cache.set(path, module);
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => {
      assert.ok(name.startsWith("./"), `Unexpected import: ${name}`);
      return load(`../convex/onboarding/${name.slice(2)}.ts`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

const detect = load("../convex/onboarding/detect.ts");
const { preparationBrief } = load("../convex/onboarding/brief.ts");
const { stageOf } = load("../convex/onboarding/stage.ts");

const bookingRepo = [
  { path: "protected-app/package.json", content: JSON.stringify({ dependencies: { expo: "~58.0.25", convex: "^1.50.0" } }) },
  { path: "protected-app/app.json", content: '{ "expo": { "name": "Still Booking" } }' },
  { path: "protected-app/app/index.tsx", content: 'import { api } from "../../convex/_generated/api";\nconst flags = useQuery(api.bookingDemo.booking.getFlags);' },
  { path: "convex/bookingDemo/checks.ts", content: "const runId = crypto.randomUUID();\nawait cleanup({ fixtureRunId: runId });" },
  { path: "convex/http.ts", content: 'import { revision } from "./bookingDemo/catalog";\nhttp.route({ path: "/booking-demo/health", method: "GET" });\nhttp.route({ path: "/booking-demo/flags", method: "POST" });' },
  { path: "convex/fixes.ts", content: 'import { v } from "convex/values";\nconst x = "/health";' },
  { path: "package.json", content: JSON.stringify({ dependencies: { expo: "~58", convex: "^1.50.0", next: "1" } }) },
];

test("parses repository URLs, including a folder link, and refuses paths outside the repository", () => {
  assert.deepEqual(detect.parseGithubUrl("https://github.com/ronoktanvir/turtl"), { repo: "ronoktanvir/turtl" });
  assert.deepEqual(detect.parseGithubUrl("github.com/owner/name.git/"), { repo: "owner/name" });
  assert.deepEqual(detect.parseGithubUrl("https://github.com/o/n/tree/main/protected-app"), { repo: "o/n", folder: "protected-app" });
  assert.equal(detect.parseGithubUrl("https://gitlab.com/o/n"), null);
  assert.deepEqual(detect.normalizeFolders([" ./protected-app/ ", "convex/bookingDemo", "", "protected-app"]), ["protected-app", "convex/bookingDemo"]);
  assert.throws(() => detect.normalizeFolders(["../etc"]), /not a folder inside/);
});

test("scopes an app to its folders plus files that import from them", () => {
  const scoped = detect.scopeFiles(bookingRepo, ["protected-app", "convex/bookingDemo"]).map((file) => file.path);
  assert.ok(scoped.includes("convex/http.ts"), "the router that imports the app is in scope");
  assert.ok(!scoped.includes("convex/fixes.ts"), "turtl's own code is not");
  assert.ok(!scoped.includes("package.json"), "the root manifest is not");
  assert.equal(detect.scopeFiles(bookingRepo, []).length, bookingRepo.length);
});

test("names Expo with a Convex backend as supported and any other stack as not supported", () => {
  const booking = detect.detectStack(detect.scopeFiles(bookingRepo, ["protected-app", "convex/bookingDemo"]));
  assert.equal(booking.id, "expo-convex");
  assert.equal(booking.supported, true);
  assert.ok(booking.evidence.some((line) => line.includes("protected-app/package.json depends on expo")));
  const next = detect.detectStack([
    { path: "package.json", content: JSON.stringify({ dependencies: { next: "16.4.6", pg: "8" } }) },
    { path: "db/schema.sql", content: "create table scores ();" },
  ]);
  assert.equal(next.label, "Next.js with Postgres");
  assert.equal(next.supported, false);
  assert.equal(detect.detectStack([{ path: "README.md", content: "hi" }]).supported, false);
});

test("finds pattern leads per item, spread across files", () => {
  const hits = detect.scanSignals(detect.scopeFiles(bookingRepo, ["protected-app", "convex/bookingDemo"]));
  assert.ok(hits.health_check.some((hit) => hit.path === "convex/http.ts" && hit.line === 2));
  assert.ok(hits.recovery_hooks.some((hit) => hit.path === "convex/http.ts" && hit.line === 3));
  assert.ok(hits.test_fixtures.some((hit) => hit.path === "convex/bookingDemo/checks.ts"));
  assert.ok(hits.error_logs.some((hit) => hit.text.includes("runId")));
  assert.equal(hits.readiness_check.length, 0);
});

test("keeps only citations of files turtl read, and downgrades an unconfirmed found to unknown", () => {
  const scoped = detect.scopeFiles(bookingRepo, ["protected-app", "convex/bookingDemo"]);
  const items = detect.confirmItems(
    [
      { key: "health_check", status: "found", note: "It answers.", files: [{ path: "convex/http.ts", line: 2 }, { path: "convex/http.ts", line: 999 }, { path: "made/up.ts", line: 1 }] },
      { key: "readiness_check", status: "found", note: "Claimed.", files: [{ path: "nowhere.ts", line: 3 }] },
      { key: "feature_flags", status: "missing", note: "None.", files: [{ path: "convex/http.ts", line: 3 }] },
    ],
    scoped,
  );
  assert.equal(items.length, detect.READINESS_ITEMS.length);
  assert.deepEqual(items.find((item) => item.key === "health_check").files, [{ path: "convex/http.ts", line: 2 }, { path: "convex/http.ts" }]);
  const readiness = items.find((item) => item.key === "readiness_check");
  assert.equal(readiness.status, "unknown");
  assert.match(readiness.note, /could not confirm a file/);
  assert.deepEqual(items.find((item) => item.key === "feature_flags").files, []);
  assert.equal(items.find((item) => item.key === "journey_checks").status, "unknown");
});

test("the rule-based fallback never calls anything missing", () => {
  const items = detect.ruleItems(detect.scanSignals(bookingRepo));
  assert.ok(items.every((item) => item.status !== "missing"));
  assert.ok(items.filter((item) => item.status === "found").every((item) => /no model judged/.test(item.note)));
});

test("parses turtl.json and rejects unsafe paths and secrets in place of variable names", () => {
  const parsed = detect.parseManifest(JSON.stringify({
    version: 1,
    credentialRef: "PROTECTED_APP_CONTROL_SECRET",
    health: { path: "/health" },
    readiness: { name: "Ready", path: "/ready" },
    journeys: [{ name: "Book", path: "/journey-check", authenticated: true }, { name: "Bad", path: "https://evil.example/x" }],
    flags: [{ name: "Recommendations", field: "recommendationsEnabled", path: "/flags", authenticated: true }, { name: "No field", path: "/x", field: "1bad" }],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.health.name, "Health check");
  assert.deepEqual(parsed.manifest.journeys.map((j) => j.name), ["Book"]);
  assert.deepEqual(parsed.manifest.flags.map((f) => f.field), ["recommendationsEnabled"]);
  assert.deepEqual(parsed.manifest.recoveryHooks, []);
  assert.equal(detect.parseManifest("{").ok, false);
  assert.equal(detect.parseManifest(JSON.stringify({ version: 2 })).ok, false);
  assert.equal(detect.parseManifest(JSON.stringify({ version: 1, credentialRef: "sk-live-abc" })).ok, false);
  assert.equal(detect.manifestPath(["protected-app", "convex/bookingDemo"]), "protected-app/turtl.json");
  assert.equal(detect.manifestPath([]), "turtl.json");
});

test("the pull request brief comes from the report and the owner's answers", () => {
  const { title, message } = preparationBrief({
    appName: "turtl/protected-app",
    repo: "ronoktanvir/turtl",
    baseBranch: "main",
    folders: ["protected-app"],
    liveUrl: "https://example.convex.site/booking-demo",
    ref: "abc123",
    stack: { id: "expo-convex", label: "Expo with a Convex backend", supported: true, evidence: [] },
    items: [
      { key: "health_check", status: "found", note: "It answers.", files: [{ path: "convex/http.ts", line: 26 }] },
      { key: "readiness_check", status: "missing", note: "No readiness check.", files: [] },
      { key: "feature_flags", status: "unknown", note: "Could not tell.", files: [] },
    ],
    hasManifest: false,
    neverBreak: [
      { text: "A customer can see the times.", addCheck: true },
      { text: "A failed booking shows a reference.", addCheck: false },
    ],
  });
  assert.match(title, /^turtl onboarding: prepare turtl\/protected-app/);
  assert.match(message, /Health check: It answers\. \(convex\/http\.ts:26\)/);
  assert.match(message, /Readiness check \(missing\): No readiness check\./);
  assert.match(message, /Feature flags \(turtl could not tell; check, and add it only if it is really absent\)/);
  assert.match(message, /Add one journey check for each of these[^]*- A customer can see the times\./);
  assert.match(message, /asked for no check now[^]*- A failed booking shows a reference\./);
  assert.match(message, /Add `turtl\.json` at that path/);
  assert.match(message, /explain each addition in plain words/);
  assert.match(message, /Add tests for every endpoint/);
  assert.match(message, /Do not merge it/);
});

test("the stage follows the inspection, the answers, the approval and the pull request", () => {
  const done = { status: "done", stack: { supported: true }, items: [{ status: "found" }, { status: "missing" }], hasManifest: false };
  const fresh = { neverBreak: [] };
  assert.equal(stageOf(null, fresh), "inspecting");
  assert.equal(stageOf({ ...done, status: "failed" }, fresh), "inspection_failed");
  assert.equal(stageOf({ ...done, stack: { supported: false } }, fresh), "unsupported");
  assert.equal(stageOf(done, fresh), "asking");
  assert.equal(stageOf(done, { ...fresh, answeredAt: 1 }), "ready");
  assert.equal(stageOf({ ...done, items: [{ status: "found" }], hasManifest: true }, { ...fresh, answeredAt: 1 }), "nothing_to_add");
  assert.equal(stageOf(done, { ...fresh, answeredAt: 1, approvedAt: 2 }), "opening");
  assert.equal(stageOf(done, { ...fresh, approvedAt: 2, openError: "x" }), "opening_failed");
  assert.equal(stageOf(done, { ...fresh, approvedAt: 2, number: 5, snapshot: { state: "open" } }), "pr_open");
  assert.equal(stageOf(done, { ...fresh, approvedAt: 2, number: 5, snapshot: { state: "closed" } }), "closed");
  assert.equal(stageOf(done, { ...fresh, mergedAt: 3, registration: { status: "checking" } }), "registering");
  assert.equal(stageOf(done, { ...fresh, mergedAt: 3, registration: { status: "done" } }), "registered");
});
