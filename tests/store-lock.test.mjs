import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsDevTools, resolveAppEnv, usesLiveData } from "../data/source.ts";
import buildEnv from "../release/build-env.js";

const demo = "https://patient-kudu-956.convex.cloud";
const production = "https://production-backend.convex.cloud";

test("an unset environment is development, and a name nobody defined is locked like production", () => {
  assert.equal(resolveAppEnv(undefined), "development");
  assert.equal(resolveAppEnv(""), "development");
  assert.equal(resolveAppEnv("development"), "development");
  assert.equal(resolveAppEnv("preview"), "preview");
  assert.equal(resolveAppEnv("production"), "production");
  for (const typo of ["prod", "Production", "staging", "dev", " development"]) assert.equal(resolveAppEnv(typo), "production");
});

test("the build check and the app agree on every environment name", () => {
  for (const name of [undefined, "", "development", "preview", "production", "prod", "Development", "store"]) {
    assert.equal(buildEnv.resolveAppEnv(name), resolveAppEnv(name));
  }
});

test("a preview or production build is always on live data, whatever the build environment says", () => {
  for (const env of ["preview", "production"]) {
    assert.equal(usesLiveData(production, "example", env), true);
    assert.equal(usesLiveData(undefined, undefined, env), true);
    assert.equal(usesLiveData("", "example", env), true);
  }
});

test("a development build keeps today's rules for example data", () => {
  assert.equal(usesLiveData(demo, "example", "development"), false);
  assert.equal(usesLiveData(undefined, undefined, "development"), false);
  assert.equal(usesLiveData(demo, undefined, "development"), true);
  assert.equal(usesLiveData(demo, "example"), false);
});

test("the dev tools cannot be switched on in a preview or production build", () => {
  for (const env of ["preview", "production"]) {
    assert.equal(allowsDevTools(env, false, "1"), false);
    assert.equal(allowsDevTools(env, true, "1"), false);
  }
  assert.equal(allowsDevTools("development", false, "1"), true);
  assert.equal(allowsDevTools("development", true, undefined), true);
  assert.equal(allowsDevTools("development", false, undefined), false);
  assert.equal(allowsDevTools("development", false, "true"), false);
});

test("the demo build environment passes the build check untouched", () => {
  assert.deepEqual(buildEnv.storeBuildProblems({ EXPO_PUBLIC_CONVEX_URL: demo, EXPO_PUBLIC_DATA_SOURCE: "example", EXPO_PUBLIC_DEV_TOOLS: "1" }), []);
  assert.deepEqual(buildEnv.storeBuildProblems({}), []);
  assert.deepEqual(buildEnv.storeBuildProblems({ EXPO_PUBLIC_APP_ENV: "development", EAS_BUILD_PROFILE: "development", EXPO_PUBLIC_DEV_TOOLS: "1" }), []);
});

test("a production build is refused with demo switches, the demo backend, or a plain http address", () => {
  const problems = (env) => buildEnv.storeBuildProblems({ EXPO_PUBLIC_APP_ENV: "production", ...env });
  assert.deepEqual(problems({ EXPO_PUBLIC_CONVEX_URL: production }), []);
  assert.match(problems({ EXPO_PUBLIC_CONVEX_URL: production, EXPO_PUBLIC_DEV_TOOLS: "1" })[0], /EXPO_PUBLIC_DEV_TOOLS=1/);
  assert.match(problems({ EXPO_PUBLIC_CONVEX_URL: production, EXPO_PUBLIC_DATA_SOURCE: "example" })[0], /EXPO_PUBLIC_DATA_SOURCE=example/);
  assert.match(problems({ EXPO_PUBLIC_CONVEX_URL: demo })[0], /demo backend/);
  assert.match(problems({ EXPO_PUBLIC_CONVEX_URL: "http://192.168.1.4:3210" })[0], /https/);
  assert.match(problems({ EXPO_PUBLIC_CONVEX_URL: "not an address" })[0], /https/);
  assert.deepEqual(buildEnv.storeBuildProblems({ EXPO_PUBLIC_APP_ENV: "preview", EXPO_PUBLIC_CONVEX_URL: demo }), []);
  assert.match(buildEnv.storeBuildProblems({ EXPO_PUBLIC_APP_ENV: "prod", EXPO_PUBLIC_CONVEX_URL: production })[0], /development, preview, or production/);
});

test("on the EAS builder a store profile needs its backend address and its own environment name", () => {
  const problems = (env) => buildEnv.storeBuildProblems({ EAS_BUILD_PROFILE: "production", ...env });
  assert.deepEqual(problems({ EXPO_PUBLIC_APP_ENV: "production", EXPO_PUBLIC_CONVEX_URL: production }), []);
  assert.match(problems({ EXPO_PUBLIC_APP_ENV: "production" })[0], /EXPO_PUBLIC_CONVEX_URL is not set/);
  assert.match(problems({ EXPO_PUBLIC_CONVEX_URL: production })[0], /must build with EXPO_PUBLIC_APP_ENV=production/);
  assert.match(problems({ EXPO_PUBLIC_APP_ENV: "preview", EXPO_PUBLIC_CONVEX_URL: production })[0], /must build with EXPO_PUBLIC_APP_ENV=production/);
  assert.deepEqual(buildEnv.storeBuildProblems({ EXPO_PUBLIC_APP_ENV: "production" }), [], "EAS reads the config once before it loads the address, so only the builder insists on it");
});
