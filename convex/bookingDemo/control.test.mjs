import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const base = process.env.CONTROL_BASE_URL;
const secret = process.env.PROTECTED_APP_CONTROL_SECRET;
assert(base && secret, "Set CONTROL_BASE_URL and PROTECTED_APP_CONTROL_SECRET for an isolated test deployment");

async function call(path, method = "GET", body, authenticated = true) {
  const token = authenticated === "hash" ? createHash("sha256").update(secret).digest("hex") : authenticated === "wrong" ? "deliberately-invalid-token" : secret;
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  console.log(JSON.stringify({ request: { method, path, body, authorization: authenticated ? "Bearer <redacted>" : "none" }, status: response.status, response: json }));
  return { status: response.status, json };
}

assert.equal((await call("/health", "GET", undefined, false)).json.ok, true);
assert.equal(typeof (await call("/revision", "GET", undefined, false)).json.revision, "string");
assert.equal(typeof (await call("/ready", "GET", undefined, false)).json.ready, "boolean");
const originalFlag = (await call("/flags")).json.recommendationsEnabled;
const originalFailure = (await call("/staged-failure")).json;

try {
  assert.equal((await call("/flags", "GET", undefined, "wrong")).status, 401);
  assert.equal((await call("/flags", "GET", undefined, "hash")).status, 401, "The stored hash must not authenticate as a bearer token");
  for (const [path, body] of [["/flags", { recommendationsEnabled: false }], ["/staged-failure", { providerTimeout: true }], ["/staged-failure", { bookingStoreFailure: true }], ["/journey-check", undefined], ["/journey-check/catalog", undefined], ["/journey-check/recommendations-off", undefined]]) {
    assert.equal((await call(path, "POST", body, false)).status, 401);
  }
  assert.equal((await call("/flags", "POST", { recommendationsEnabled: "false" })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { providerTimeout: true, extra: true })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { providerTimeout: true, bookingStoreFailure: true })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { bookingStoreFailure: "true" })).status, 400);
  const baseline = (await call("/errors")).json.counts;

  await call("/flags", "POST", { recommendationsEnabled: true });
  await call("/staged-failure", "POST", { providerTimeout: false });
  await call("/staged-failure", "POST", { bookingStoreFailure: false });
  const manifest = JSON.parse(readFileSync(new URL("../../protected-app/turtl.json", import.meta.url), "utf8"));
  for (const [entry, method] of [[manifest.health, "GET"], [manifest.readiness, "GET"], ...manifest.journeys.map((j) => [j, "POST"]), ...[...manifest.flags, ...manifest.recoveryHooks].map((s) => [s, "GET"])]) {
    assert.equal((await call(entry.path, method, undefined, Boolean(entry.authenticated))).status, 200, `turtl.json lists ${entry.path}, so it must answer`);
  }

  for (const [enabled, timeout, storeFailure, failedStep] of [
    [true, false, false, null],
    [true, true, false, "recommendations"],
    [false, true, false, null],
    [false, false, false, null],
    [true, false, true, "submit_booking"],
    [false, false, true, "submit_booking"],
    [true, true, true, "submit_booking"],
    [false, true, true, "submit_booking"],
  ]) {
    const verdict = failedStep ? "failed" : "passed";
    assert.equal((await call("/flags", "POST", { recommendationsEnabled: enabled })).status, 200);
    assert.equal((await call("/staged-failure", "POST", { providerTimeout: timeout })).status, 200);
    const failureState = await call("/staged-failure", "POST", { bookingStoreFailure: storeFailure });
    assert.equal(failureState.status, 200);
    assert.equal(failureState.json.providerTimeout, timeout, "Setting the store failure must not change the provider failure");
    assert.equal(failureState.json.bookingStoreFailure, storeFailure);
    const result = await call("/journey-check", "POST");
    assert.equal(result.status, verdict === "passed" ? 200 : 503);
    assert.equal(result.json.verdict, verdict);
    assert.equal(result.json.failedStep, failedStep);
    if (failedStep) {
      assert.equal(result.json.error.code, failedStep === "recommendations" ? "RECOMMENDATIONS_TIMEOUT" : "BOOKING_STORE_UNAVAILABLE");
      assert.equal(result.json.steps.find((step) => step.step === failedStep)?.verdict, "failed");
    }
    assert.equal(result.json.cleanup.ok, true);
    assert.equal(result.json.cleanup.deletedBookings, verdict === "passed" ? 1 : 0);
    assert.deepEqual(result.json.configuration, { recommendationsEnabled: enabled, providerTimeout: timeout, bookingStoreFailure: storeFailure });
    const ready = await call("/ready", "GET", undefined, false);
    const failingDependency = storeFailure ? "booking_store" : enabled && timeout ? "recommendations_provider" : null;
    assert.equal(ready.status, failingDependency ? 503 : 200);
    assert.equal(ready.json.failing?.dependency ?? null, failingDependency);
    if (failingDependency) assert.equal(ready.json.failing.code, storeFailure ? "BOOKING_STORE_UNAVAILABLE" : "RECOMMENDATIONS_TIMEOUT");
    const catalogCheck = await call("/journey-check/catalog", "POST");
    assert.equal(catalogCheck.status, 200, "Staged failures never hide the treatments and times");
    assert.deepEqual(catalogCheck.json.cleanup, { ok: true, deletedBookings: 0 });
    const offCheck = await call("/journey-check/recommendations-off", "POST");
    assert.equal(offCheck.status, storeFailure ? 503 : 200);
    assert.equal(offCheck.json.failedStep, storeFailure ? "submit_booking" : null);
    if (storeFailure) assert.equal(offCheck.json.error.code, "BOOKING_STORE_UNAVAILABLE");
    assert.deepEqual(offCheck.json.cleanup, { ok: true, deletedBookings: storeFailure ? 0 : 1 });
    assert.equal(offCheck.json.configuration, undefined);
    assert.equal((await call("/flags")).json.recommendationsEnabled, enabled, "The recommendations-off check must not change the live switch");
    assert.deepEqual((await call("/errors")).json.counts, baseline, "Fixture runs must not change customer impact");
    assert.equal((await call("/health", "GET", undefined, false)).json.ok, true);
  }
  console.log("PASS: hash-only control authentication, validation, turtl.json endpoints, readiness and all three journeys in all eight staged configurations, cleanup, and impact isolation");
} finally {
  await call("/flags", "POST", { recommendationsEnabled: originalFlag });
  await call("/staged-failure", "POST", { providerTimeout: originalFailure.providerTimeout });
  await call("/staged-failure", "POST", { bookingStoreFailure: originalFailure.bookingStoreFailure });
}
