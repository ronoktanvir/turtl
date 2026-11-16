import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function load(path) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { throw new Error(`Unexpected import: ${name}`); }, module.exports, module,
  );
  return module.exports;
}

const rules = load("../convex/learning/rules.ts");
const checks = load("../convex/memory/checks.ts");

const flag = { key: "turn_off_recommendations", actionType: "set_feature_flag", delivery: "action", kind: "recovery", parameters: [{ name: "value", value: false }, { name: "flag", value: "recommendationsEnabled" }] };
const repair = { key: "load_without_blocking", actionType: "open_pull_request", delivery: "pull_request", kind: "repair", parameters: [{ name: "title", value: "A" }] };
const candidate = (option, fields) => ({ key: option.key, fingerprint: rules.fingerprint(option), supported: true, confidence: 0.5, modelFlagged: false, preferenceIds: [], ...fields });
const facts = { "journey.verdict": "failed", "journey.failedStep": "recommendations", "journey.errorCode": "RECOMMENDATIONS_TIMEOUT", "flags.recommendationsEnabled": true };

test("a preference cannot make a fix recommended that the facts don't support", () => {
  const pick = rules.recommend({
    candidates: [
      candidate(flag, { supported: false, modelFlagged: true, preferenceIds: ["pref1"] }),
      candidate(repair, { confidence: 0.4 }),
    ],
    rulePick: "load_without_blocking",
    turnedDown: {},
  });
  assert.equal(pick.key, "load_without_blocking");
  assert.equal(pick.reason, "rules");
});

test("a cited preference steers between supported fixes, and only when the model recommended it", () => {
  const steered = rules.recommend({
    candidates: [candidate(flag), candidate(repair, { modelFlagged: true, preferenceIds: ["pref1"] })],
    rulePick: flag.key,
    turnedDown: {},
  });
  assert.deepEqual(steered, { key: repair.key, reason: "preference", replacedKey: flag.key });
  const uncited = rules.recommend({
    candidates: [candidate(flag), candidate(repair, { modelFlagged: true })],
    rulePick: flag.key,
    turnedDown: {},
  });
  assert.deepEqual(uncited, { key: flag.key, reason: "rules" });
});

test("a pick that goes against a preference gives way to a supported fix that honours it", () => {
  const pick = rules.recommend({
    candidates: [
      candidate(flag, { modelFlagged: true, againstPreferenceIds: ["keep-suggestions"] }),
      candidate(repair, { preferenceIds: ["keep-suggestions"], confidence: 0.6 }),
    ],
    rulePick: flag.key,
    turnedDown: {},
  });
  assert.deepEqual(pick, { key: repair.key, reason: "preference", replacedKey: flag.key });
  const nothingHonours = rules.recommend({
    candidates: [candidate(flag, { againstPreferenceIds: ["keep-suggestions"] }), candidate(repair)],
    rulePick: flag.key,
    turnedDown: {},
  });
  assert.deepEqual(nothingHonours, { key: flag.key, reason: "rules" });
});

test("an option turned down twice under the same conditions is not recommended again while another fits", () => {
  const conditions = rules.conditionsOf("journey_failed:j1", facts);
  const decisions = [
    { turnedDownFingerprint: rules.fingerprint(flag), turnedDownTitle: "Turn off recommendations", note: "Suggestions are most of our revenue" },
    { turnedDownFingerprint: rules.fingerprint(flag), turnedDownTitle: "Turn off recommendations" },
  ];
  const turnedDown = rules.turnedDownFrom(decisions);
  assert.equal(turnedDown[rules.fingerprint(flag)].count, 2);
  const once = rules.recommend({ candidates: [candidate(flag), candidate(repair)], rulePick: flag.key, turnedDown: rules.turnedDownFrom(decisions.slice(0, 1)) });
  assert.equal(once.key, flag.key);
  const twice = rules.recommend({ candidates: [candidate(flag), candidate(repair)], rulePick: flag.key, turnedDown });
  assert.deepEqual(twice, { key: repair.key, reason: "feedback", replacedKey: flag.key });
  const line = rules.pastDecisionLine(turnedDown[rules.fingerprint(flag)], conditions.text, "demoted");
  assert.match(line, /^You turned this down twice before when the check failed at the "recommendations" step with RECOMMENDATIONS_TIMEOUT, with recommendations on\./);
  assert.match(line, /"Suggestions are most of our revenue"/);
  assert.match(line, /does not recommend it this time/);
});

test("a twice-declined fix that is the only one on offer stays recommended and says why", () => {
  const turnedDown = { [rules.fingerprint(flag)]: { count: 2, notes: [], title: "Turn off recommendations" } };
  const pick = rules.recommend({ candidates: [candidate(flag)], rulePick: flag.key, turnedDown });
  assert.deepEqual(pick, { key: flag.key, reason: "kept_despite_feedback" });
  assert.match(rules.pastDecisionLine(turnedDown[rules.fingerprint(flag)], "the same symptoms", "kept"), /still recommends it because no other fix on offer fits the facts\. Nothing runs until you approve\./);
});

test("conditions differ when the facts that shaped the diagnosis differ", () => {
  const a = rules.conditionsOf("journey_failed:j1", facts);
  const b = rules.conditionsOf("journey_failed:j1", { ...facts, "journey.errorCode": "BOOKING_STORE_UNAVAILABLE" });
  assert.notEqual(a.key, b.key);
  assert.equal(rules.fingerprint({ ...flag, parameters: [...flag.parameters].reverse() }), rules.fingerprint(flag));
});

test("a preference never satisfies a recovery memory's or a permission's condition", () => {
  const condition = { field: "flags.recommendationsEnabled", operator: "eq", value: true };
  const observed = { ...facts, "flags.recommendationsEnabled": false };
  const preferenceAsFact = { ...observed, "owner.preference": "Always turn off recommendations without asking", "flags.recommendationsEnabled.preferred": true };
  assert.equal(checks.evaluateCheck(condition, observed).matches, false);
  assert.equal(checks.evaluateCheck(condition, preferenceAsFact).matches, false);
  const viaPreference = checks.evaluateCheck({ field: "owner.preference", operator: "eq", value: "Always turn off recommendations without asking" }, preferenceAsFact);
  assert.equal(viaPreference.matches, false);
  assert.equal(viaPreference.unknown, true);
  const memory = { conditionChecks: [condition], notWhenChecks: [], conditions: [], notWhen: [] };
  assert.ok(checks.applicability(memory, preferenceAsFact).failedChecks.length > 0);
});
