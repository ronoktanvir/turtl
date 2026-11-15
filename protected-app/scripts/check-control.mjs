import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const base = process.env.CONTROL_BASE_URL;
const secret = process.env.PROTECTED_APP_CONTROL_SECRET;
assert(base && secret, "Set CONTROL_BASE_URL and PROTECTED_APP_CONTROL_SECRET for an isolated test deployment");

async function call(path, method = "GET", body, authenticated = true) {
  const token = authenticated === "hash" ? createHash("sha256").update(secret).digest("hex") : authenticated === "wrong" ? "deliberately-invalid-token" : secret;
  const response = await fetch(new URL(path, base), {
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
const originalFlag = (await call("/flags")).json.recommendationsEnabled;
const originalFailure = (await call("/staged-failure")).json;

try {
  assert.equal((await call("/flags", "GET", undefined, "wrong")).status, 401);
  assert.equal((await call("/flags", "GET", undefined, "hash")).status, 401, "The stored hash must not authenticate as a bearer token");
  for (const [path, body] of [["/flags", { recommendationsEnabled: false }], ["/staged-failure", { providerTimeout: true }], ["/staged-failure", { bookingStoreFailure: true }], ["/journey-check", undefined]]) {
    assert.equal((await call(path, "POST", body, false)).status, 401);
  }
  assert.equal((await call("/flags", "POST", { recommendationsEnabled: "false" })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { providerTimeout: true, extra: true })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { providerTimeout: true, bookingStoreFailure: true })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { bookingStoreFailure: "true" })).status, 400);
  const baseline = (await call("/errors")).json.counts;

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
    assert.deepEqual((await call("/errors")).json.counts, baseline, "Fixture runs must not change customer impact");
    assert.equal((await call("/health", "GET", undefined, false)).json.ok, true);
  }
  console.log("PASS: hash-only control authentication, validation, all eight staged configurations, cleanup, and impact isolation");
} finally {
  await call("/flags", "POST", { recommendationsEnabled: originalFlag });
  await call("/staged-failure", "POST", { providerTimeout: originalFailure.providerTimeout });
  await call("/staged-failure", "POST", { bookingStoreFailure: originalFailure.bookingStoreFailure });
}
