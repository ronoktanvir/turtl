import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLoader } from "./fixtures/convex-memory.mjs";

// Step summaries, reasons and notes under convex/ reach a case's Plan and Logs. An owner who cannot read a stack
// trace read "OPENAI_API_KEY is not set on this deployment, so no model was asked" and raw error messages there.
// The setting's name and the error's detail stay with the operator, in the backend's log.

const { NO_MODEL_REASON, NO_SUPERMEMORY, UNEXPECTED_STOP } = createLoader()("convex/constants.ts");
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const SETTING = /\b(OPENAI|SUPERMEMORY)_API_KEY\b/;

test("the words for a missing service name no setting", () => {
  for (const words of [NO_MODEL_REASON, NO_SUPERMEMORY, UNEXPECTED_STOP]) assert.doesNotMatch(words, /[A-Z]{2,}_[A-Z_]+/);
});

test("no summary, reason or note a screen can show names the model or Supermemory key", () => {
  const files = [
    "convex/fixOptions.ts", "convex/voice/openai.ts", "convex/structural/examine.ts", "convex/memory/service.ts",
    "convex/learning/preferences.ts", "convex/intake/records.ts", "convex/account/vendors.ts", "convex/codeNetwork/openai.ts",
    "convex/supermemory.ts",
  ];
  for (const file of files) {
    for (const [i, line] of read(file).split("\n").entries()) {
      const code = line.replace(/\/\/.*$/, "");
      if (!SETTING.test(code) || /process\.env\./.test(code) || /credentialRef/.test(code)) continue;
      assert.fail(`${file}:${i + 1} shows a setting's name: ${line.trim()}`);
    }
  }
});

test("a thrown error's message is logged, not written into what the owner reads", () => {
  const passes = /\$\{[^}]*error\.message[^}]*\}|error: error instanceof Error \? error\.message/;
  for (const file of ["convex/runner/run.ts", "convex/runner/handlers/gather_context.ts", "convex/structural/examine.ts"]) {
    assert.doesNotMatch(read(file), passes, file);
  }
  assert.match(read("convex/runner/run.ts"), /result = \{ status: "failed", error: UNEXPECTED_STOP \}/);
});

test("a remembered recovery is named in words, not by its id", () => {
  const gather = read("convex/runner/handlers/gather_context.ts");
  assert.doesNotMatch(gather, /Recovery memory \$\{/);
  assert.match(gather, /A recovery turtl remembers applies/);
});

test("the error window reads as a length of time and a failure in words, not timestamps and a code", () => {
  const { windowWords } = createLoader({ "convex/protectedApp/watched": {} })("convex/evidence/collectors.ts");
  const since = 1794826293447;
  assert.equal(windowWords({ since, until: since + 15 * 60_000, truncated: false }, 0, "none"), "0% of booking attempts failed in the 15 minutes before this check. No failure stood out.");
  assert.equal(windowWords({ since, until: since + 60_000, truncated: true }, 0.25, "RECOMMENDATIONS_TIMEOUT"), "25% of booking attempts failed in the 1 minute before this check. The most common failure was recommendations timeout. Only a sample of the bookings in that time was read.");
});

test("a model provider without a key is named, not its setting", () => {
  const models = read("convex/routing/models.ts");
  assert.doesNotMatch(models, /\$\{keyName\} is not set/);
  assert.match(models, /is not connected to turtl yet, so no request was sent/);
});

test("a missing encryption key or GitHub token is not named to the owner", () => {
  const { NO_SEALING_KEY } = createLoader()("convex/secrets/words.ts");
  assert.doesNotMatch(NO_SEALING_KEY, /[A-Z]{2,}_[A-Z_]+/);
  assert.match(NO_SEALING_KEY, /operator/);
  assert.doesNotMatch(read("convex/protectedApp/watched.ts"), /\(SECRETS_ENCRYPTION_KEY\)/);
  assert.match(read("convex/secrets/seal.ts"), /console\.error\(`\$\{KEY_VARIABLE\} is not set/);
  for (const line of read("convex/codeNetwork/build.ts").split("\n").filter((l) => /reason: `/.test(l))) assert.doesNotMatch(line, /GITHUB_TOKEN/, line);
});

test("reading a repository through the GitHub connection blames the connection, never a token", () => {
  const { unreadable } = createLoader({ "convex/prTracking/github": { github: async () => ({ ok: false }) } })("convex/onboarding/github.ts");
  const refused = { ok: false, status: 401, message: "Bad credentials" };
  const connected = unreadable("acme/app", { ...refused, status: 404 }, undefined, true, true);
  assert.match(connected, /^turtl reaches acme\/app through your GitHub connection, but GitHub turned that connection down just now\./);
  assert.doesNotMatch(connected, /token|connect it to turtl through GitHub \(Add project/i);
  const notConnected = unreadable("acme/app", { ...refused, status: 404 }, undefined, false);
  assert.match(notConnected, /connect it to turtl through GitHub \(Add project, Connect GitHub\)/);
  const odd = unreadable("acme/app", { ok: false, status: 502, message: "Bad gateway <html>" }, "t", false);
  assert.equal(odd, "GitHub did not answer when turtl tried to read acme/app. Try again in a few minutes.");
  assert.match(read("convex/onboarding/inspect.ts"), /readRepository\(inspection\.repo, access\.token, access\.source === "installation"\)/);
});

test("a journey check's stored words carry no error code or run id", () => {
  const { describeJourney, journeyBody } = createLoader({ "convex/protectedApp/watched": {} })("convex/protectedApp/client.ts");
  const failed = {
    verdict: "failed", failedStep: "recommendations", runId: "6198e797-0455-400c-891b-571e2f63275e", revision: "local-qa",
    error: { code: "RECOMMENDATIONS_TIMEOUT", message: "The recommendation provider timed out." },
    steps: [{ step: "load_catalog", verdict: "passed", detail: "Selected a service." }, { step: "recommendations", verdict: "failed", detail: "Timed out." }],
    cleanup: { ok: true, deletedBookings: 1 },
  };
  assert.equal(describeJourney(failed), 'The booking check failed at the "recommendations" step, so no booking was saved.');
  assert.equal(describeJourney({ ...failed, failedStep: undefined }), "The booking check failed, so no booking was saved.");
  assert.equal(journeyBody(failed), "load_catalog: passed. Selected a service.\nrecommendations: failed. Timed out.\nError: The recommendation provider timed out.\nCleanup succeeded (1 test booking deleted).");
  assert.match(journeyBody({ ...failed, error: undefined, cleanup: { ok: true, deletedBookings: 0 } }), /Cleanup succeeded \(0 test bookings deleted\)\.$/);
  for (const text of [describeJourney(failed), journeyBody(failed)]) for (const raw of ["RECOMMENDATIONS_TIMEOUT", "6198e797", "local-qa"]) assert.ok(!text.includes(raw), raw);
});

test("a setting change is reported with the setting's name in words", () => {
  const { settingName } = createLoader()("convex/constants.ts");
  assert.equal(settingName("recommendationsEnabled"), "recommendations");
  assert.equal(settingName("dark_mode_enabled"), "dark mode");
  assert.equal(settingName("checkoutV2"), "checkout v2");
  const source = read("convex/runner/handlers/authorize_and_execute.ts");
  assert.match(source, /Turned \$\{settingName\(flag\)\} \$\{value \? "on" : "off"\}, and the booking app confirmed the change\./);
  assert.doesNotMatch(source, /label: action\.type \}/);
});

test("a booking step is named in words, never by its id, wherever the owner reads where a check stopped", () => {
  const { describeJourney } = createLoader({ "convex/protectedApp/watched": {} })("convex/protectedApp/client.ts");
  const failed = { verdict: "failed", failedStep: "submit_booking", steps: [], cleanup: { ok: true, deletedBookings: 0 } };
  assert.equal(describeJourney(failed), 'The booking check failed at the "submit booking" step, so no booking was saved.');
  const { failedRunWords } = createLoader()("convex/structural/checks.ts");
  assert.equal(failedRunWords("submit_booking"), 'Its first run failed at the "submit booking" step.');
  const monitor = read("convex/monitor.ts");
  assert.match(monitor, /The booking check fails at the "\$\{failedStep\.replace\(\/_\/g, " "\)\}" step/);
  assert.match(monitor, /It failed at the "\$\{failedStep\.replace\(\/_\/g, " "\)\}" step\./);
});

test("turtl's own reading (no AI) says what it knows in words: no error codes, no \"cause is unknown\"", () => {
  const { ruleReading } = createLoader()("convex/diagnosis.ts");
  const evidence = [{ id: "e1", kind: "journey_check" }, { id: "e2", kind: "errors" }];
  const store = ruleReading({ "journey.verdict": "failed", "journey.failedStep": "submit_booking", "journey.errorCode": "BOOKING_STORE_UNAVAILABLE", "health.ok": true }, evidence);
  assert.equal(store.cause, "The booking store answers that it is unavailable, so every booking fails when it is saved.");
  assert.equal(store.confidence, 0.5);
  const other = ruleReading({ "journey.verdict": "failed", "journey.failedStep": "pay_now", "journey.errorCode": "PAYMENT_PROVIDER_DOWN", "health.ok": true }, evidence);
  assert.equal(other.cause, 'The booking check stops at the "pay now" step. The app itself still answers. turtl\'s own rules know where it stops but not why, so they do not guess at a cause.');
  assert.equal(other.confidence, 0.1);
  const bare = ruleReading({ "journey.verdict": "failed" }, evidence);
  assert.match(bare.cause, /^The booking check stops before a booking is saved\. turtl's own rules/);
  for (const reading of [store, other, bare]) assert.doesNotMatch(reading.cause, /[A-Z]{2,}_[A-Z_]+|unknown|_/);
  assert.match(read("convex/runner/handlers/investigate.ts"), /\$\{cost > 0 \? ` Model cost about \$\{money\(cost\)\}\.` : ""\}/);
});
