import assert from "node:assert/strict";

const base = process.env.CONTROL_BASE_URL;
const secret = process.env.PROTECTED_APP_CONTROL_SECRET;
assert(base && secret, "Set CONTROL_BASE_URL and PROTECTED_APP_CONTROL_SECRET for an isolated test deployment");

async function call(path, method = "GET", body, authenticated = true) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${secret}` } : {}),
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
const originalFailure = (await call("/staged-failure")).json.providerTimeout;

try {
  for (const [path, body] of [["/flags", { recommendationsEnabled: false }], ["/staged-failure", { providerTimeout: true }], ["/journey-check", undefined]]) {
    assert.equal((await call(path, "POST", body, false)).status, 401);
  }
  assert.equal((await call("/flags", "POST", { recommendationsEnabled: "false" })).status, 400);
  assert.equal((await call("/staged-failure", "POST", { providerTimeout: true, extra: true })).status, 400);
  const baseline = (await call("/errors")).json.counts;

  for (const [enabled, timeout, verdict] of [[true, false, "passed"], [true, true, "failed"], [false, true, "passed"]]) {
    assert.equal((await call("/flags", "POST", { recommendationsEnabled: enabled })).status, 200);
    assert.equal((await call("/staged-failure", "POST", { providerTimeout: timeout })).status, 200);
    const result = await call("/journey-check", "POST");
    assert.equal(result.status, verdict === "passed" ? 200 : 503);
    assert.equal(result.json.verdict, verdict);
    assert.equal(result.json.failedStep, verdict === "failed" ? "recommendations" : null);
    assert.equal(result.json.cleanup.ok, true);
    assert.equal(result.json.cleanup.deletedBookings, verdict === "passed" ? 1 : 0);
    assert.deepEqual(result.json.configuration, { recommendationsEnabled: enabled, providerTimeout: timeout });
    assert.deepEqual((await call("/errors")).json.counts, baseline, "Fixture runs must not change customer impact");
    assert.equal((await call("/health", "GET", undefined, false)).json.ok, true);
  }
  console.log("PASS: control authentication, validation, three journey states, cleanup, and impact isolation");
} finally {
  await call("/flags", "POST", { recommendationsEnabled: originalFlag });
  await call("/staged-failure", "POST", { providerTimeout: originalFailure });
}
