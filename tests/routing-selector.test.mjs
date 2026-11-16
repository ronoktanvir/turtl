import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIGURATIONS } from "../convex/routing/configs.ts";
import { bucketOf, MIN_SAMPLE, selectConfiguration, unsupportedReasons } from "../convex/routing/selector.ts";

const traits = (fields = {}) => ({
  caseKind: "outage", reproduces: "yes", signals: ["the journey fails at submit_booking", "4 customer attempts failed"],
  components: ["submit_booking"], evidenceKinds: 5, evidenceExpected: 5, memory: "none", failure: "submit_booking:BOOKING_STORE_UNAVAILABLE",
  familiarFailure: false, consequence: "low", consequenceWhy: "the actions on offer can be undone (Turn off recommendations)", ...fields,
});
const roomy = { timeLeftMs: 150_000, budgetLeftUsd: 0.5 };
const select = (t, log = [], limits = roomy) => selectConfiguration({ traits: t, limits, log, configs: CONFIGURATIONS });
const entries = (t, configKey, outcomes) => outcomes.map((outcome) => ({ configKey, bucket: bucketOf(t), outcome }));

test("a plain, reproducing, one-place failure goes to the quick look", () => {
  const choice = select(traits());
  assert.equal(choice.configKey, "quick");
  assert.match(choice.reason, /^Quick look: the failure reproduces and points at one place/);
});

test("difficulty raises a case to the careful review", () => {
  const choice = select(traits({ reproduces: "no" }));
  assert.equal(choice.configKey, "careful");
  assert.match(choice.reason, /did not reproduce on a fresh check/);
  assert.equal(select(traits({ memory: "look_alike_rejected" })).configKey, "careful");
});

test("consequence is separate from difficulty: an easy sensitive change still gets the careful review", () => {
  const easy = traits({ familiarFailure: true, consequence: "high", consequenceWhy: "the failure touches session" });
  assert.equal(select(easy).configKey, "careful");
  assert.match(select(easy).reason, /consequential \(the failure touches session\)/);
  const log = entries(easy, "quick", ["verified", "verified", "verified", "verified"]);
  assert.equal(select(easy, log).configKey, "careful", "a good record never downgrades a consequential case");
});

test("the log moves the preference only past the minimum sample, within the same traits", () => {
  const t = traits();
  const twoFailures = entries(t, "quick", ["failed", "failed"]);
  assert.equal(select(t, twoFailures).configKey, "quick", `fewer than ${MIN_SAMPLE} outcomes do not move routing`);
  const threeFailures = entries(t, "quick", ["failed", "failed", "corrected"]);
  const moved = select(t, threeFailures);
  assert.equal(moved.configKey, "careful");
  assert.match(moved.reason, /performance log changed this\. In 3 similar cases the quick look was verified in 0/);
  const elsewhere = entries(traits({ failure: "x", components: ["a", "b"] }), "quick", ["failed", "failed", "failed"]);
  assert.equal(select(t, elsewhere).configKey, "quick", "outcomes from other traits are not compared");
  const otherArea = entries(traits({ components: ["recommendations"], failure: "recommendations:RECOMMENDATIONS_TIMEOUT" }), "quick", ["failed", "failed", "failed"]);
  assert.equal(select(t, otherArea).configKey, "quick", "a different part of the app is a different task");
});

test("infrastructure failures do not count against a configuration", () => {
  const t = traits();
  const log = entries(t, "quick", ["infra_failure", "infra_failure", "infra_failure", "failed"]);
  assert.equal(select(t, log).configKey, "quick");
  assert.deepEqual(select(t, log).record.quick, { counted: 1, verified: 0 });
});

test("a strong quick record brings a harder-looking case back to the quick look", () => {
  const t = traits({ reproduces: "unknown" });
  assert.equal(select(t).configKey, "careful");
  const moved = select(t, entries(t, "quick", ["verified", "verified", "verified", "verified", "failed"]));
  assert.equal(moved.configKey, "quick");
  assert.match(moved.reason, /verified in 4/);
});

test("time and cost limits keep the careful review out when it cannot fit", () => {
  const choice = select(traits({ reproduces: "no" }), [], { timeLeftMs: 20_000, budgetLeftUsd: 0.05 });
  assert.equal(choice.configKey, "quick");
  assert.match(choice.reason, /does not fit the limits: the case has \$0\.05 of model budget left and the step has 20 s left/);
});

test("the selector is deterministic for the same inputs and log, whatever the log's order", () => {
  const t = traits();
  const log = [...entries(t, "quick", ["failed", "verified", "failed", "failed"]), ...entries(traits({ reproduces: "no" }), "careful", ["verified"])];
  const first = select(t, log);
  for (let i = 0; i < 20; i++) assert.deepEqual(select(structuredClone(t), structuredClone(log)), first);
  assert.deepEqual(select(t, [...log].reverse()), first);
});

test("a diagnosis is established only when it accounts for the failure and something beyond its symptoms supports it", () => {
  const facts = { "journey.verdict": "failed", "journey.failedStep": "recommendations", "flags.recommendationsEnabled": true, "health.ok": true };
  const kinds = { e1: "journey_check", e2: "flags", e3: "errors" };
  assert.deepEqual(unsupportedReasons({ confidence: 0.9, supportingEvidenceIds: ["e1", "e2"], supportingFactKeys: ["journey.failedStep", "flags.recommendationsEnabled"] }, facts, kinds), []);
  assert.deepEqual(unsupportedReasons({ confidence: 0.98, supportingEvidenceIds: ["e1", "e3"], supportingFactKeys: ["journey.failedStep", "journey.errorCode", "health.ok"] }, facts, kinds), [
    "it rests only on the failure's own symptoms, which show what failed but not why",
  ]);
  assert.deepEqual(unsupportedReasons({ confidence: 0.45, supportingEvidenceIds: [], supportingFactKeys: ["health.ok"] }, facts, kinds), [
    "its confidence is 45%, below 60%", "it cites no evidence", "it does not account for the failed step or its error code",
    "it rests only on the failure's own symptoms, which show what failed but not why",
  ]);
});
