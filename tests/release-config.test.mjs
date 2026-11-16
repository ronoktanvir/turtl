import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { deploymentProblems, markdownTable, variables } from "../release/backend-env.mjs";
import { appConfigProblems, easProblems, privacyManifestProblems } from "../release/store-checks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("app.json carries what the App Store needs: iPhone only, export compliance, an opaque 1024 icon", () => {
  assert.deepEqual(appConfigProblems(root), []);
});

test("the privacy manifest declares every reason the installed native libraries declare", () => {
  assert.deepEqual(privacyManifestProblems(root), []);
});

test("eas.json has a development, a preview and a production profile, each with its own environment", () => {
  assert.deepEqual(easProblems(root), []);
});

test("the app config refuses a production build with a demo switch and resolves a clean one", () => {
  const config = (env) => spawnSync("npx", ["expo", "config", "--type", "public", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, EXPO_PUBLIC_DATA_SOURCE: "", EXPO_PUBLIC_DEV_TOOLS: "", EXPO_PUBLIC_APP_ENV: "production", EXPO_PUBLIC_CONVEX_URL: "https://production-backend.convex.cloud", ...env } });
  const refused = config({ EXPO_PUBLIC_DEV_TOOLS: "1" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /A production build never shows the dev tools/);
  const clean = config({});
  assert.equal(clean.status, 0, clean.stderr);
  const expo = JSON.parse(clean.stdout);
  assert.equal(expo.ios.bundleIdentifier, "com.turtl.oncall");
  assert.equal(expo.scheme, "turtl");
  assert.deepEqual(expo.plugins.find((plugin) => plugin[0] === "expo-secure-store"), ["expo-secure-store", { faceIDPermission: false }]);
});

test("the runbook shows the same variable table the check uses", () => {
  const runbook = readFileSync(new URL("../release/backend-runbook.md", import.meta.url), "utf8");
  assert.ok(runbook.includes(`<!-- variables:start -->\n${markdownTable()}\n<!-- variables:end -->`), "Run: node release/check-backend-env.mjs --write-table");
});

test("a production backend is refused without its keys, with a dev switch, or with a variable nobody listed", () => {
  const required = variables.filter((row) => row.production === "required").map((row) => row.name);
  assert.deepEqual(deploymentProblems(required), []);
  assert.deepEqual(deploymentProblems([...required, "VOICE_ENABLED", "CONVEX_SITE_URL"]), []);
  assert.match(deploymentProblems(required.slice(1))[0], new RegExp(`${required[0]} is required`));
  assert.match(deploymentProblems([...required, "DEV_TOOLS_ENABLED"])[0], /DEV_TOOLS_ENABLED is set and must never be set/);
  assert.match(deploymentProblems([...required, "DEV_TOOLS_ENABLD"])[0], /DEV_TOOLS_ENABLD is set but has no row/);
  assert.ok(variables.some((row) => row.name === "DEV_TOOLS_ENABLED" && row.production === "never"));
});
