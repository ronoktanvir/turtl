import assert from "node:assert/strict";
import { test } from "node:test";
import { readFinding, relatedCases, scenarioUrl, shouldExamine } from "../convex/structural/rules.ts";

const kase = (id, fields = {}) => ({
  id, title: `Case ${id}`, createdAt: Number(id.replace(/\D/g, "")) * 1000, signature: "journey_failed:j1",
  failedStep: "recommendations", memoryIds: [], verifiedRecovery: false, isSample: false, ...fields,
});

test("no related history: not examined, and the summary says so", () => {
  const result = shouldExamine(kase("c1"), []);
  assert.equal(result.examine, false);
  assert.equal(result.summary, "Not examined: no related cases.");
  assert.doesNotMatch(result.summary, /placeholder/i);
});

test("cases on another signature and component are not related", () => {
  const other = kase("c1", { signature: "journey_failed:j2", failedStep: "submit_booking" });
  const result = shouldExamine(kase("c3"), [other]);
  assert.equal(result.examine, false);
  assert.equal(result.related.length, 0);
});

test("one related case without a verified recovery is not enough", () => {
  const result = shouldExamine(kase("c2", { failedStep: "submit_booking" }), [kase("c1")]);
  assert.equal(result.examine, false);
  assert.deepEqual(result.related.map((c) => c.reasons), [["signature"]]);
  assert.match(result.summary, /^Not examined: 1 related case, /);
});

test("two related cases trigger an examination", () => {
  const result = shouldExamine(kase("c3"), [kase("c1"), kase("c2", { failedStep: "submit_booking" })]);
  assert.equal(result.examine, true);
  assert.equal(result.reason, "related_history");
  assert.deepEqual(result.related.map((c) => c.id), ["c1", "c2"]);
});

test("a recurrence after a verified recovery triggers with one related case", () => {
  const result = shouldExamine(kase("c2", { memoryIds: ["m1"] }), [kase("c1", { verifiedRecovery: true, memoryIds: ["m1"] })]);
  assert.equal(result.examine, true);
  assert.equal(result.reason, "recurrence");
  assert.deepEqual(result.related[0].reasons, ["signature", "component", "cause"]);
});

test("a verified recovery that only shares the signature is not a recurrence", () => {
  const result = shouldExamine(kase("c2", { failedStep: "submit_booking" }), [kase("c1", { verifiedRecovery: true })]);
  assert.equal(result.examine, false);
});

test("later cases and the case itself are never history; seeded cases are named", () => {
  const related = relatedCases(kase("c2"), [kase("c2"), kase("c5"), kase("c1", { isSample: true })]);
  assert.deepEqual(related.map((c) => c.id), ["c1"]);
  const result = shouldExamine(kase("c3"), [kase("c1", { isSample: true }), kase("c2")]);
  assert.match(result.summary, /1 of them is a seeded sample/);
});

const known = new Map([
  ["c1", { kind: "case", label: "Case 1" }],
  ["c3", { kind: "case", label: "Case 3" }],
  ["e1", { kind: "evidence", label: "Booking check failed", caseId: "c1" }],
  ["e3", { kind: "evidence", label: "Booking check failed", caseId: "c3" }],
  ["n1", { kind: "codeNode", label: "convex/bookingDemo/journeyCore.ts" }],
]);
const complete = () => ({
  hypothesis: "Booking calls the optional recommendations provider before it saves, so any slow provider blocks every booking.",
  evidence: [
    { ref: "e1", says: "Case 1 failed at recommendations." },
    { ref: "e3", says: "Case 3 failed at recommendations again." },
    { ref: "n1", says: "The booking path calls recommend() before saving." },
  ],
  change: {
    title: "Save bookings without waiting for recommendations", kind: "repair",
    whatChanges: "Booking saves first.", whatMightBeLost: "Suggestions may load late.",
    scope: ["convex/bookingDemo/journeyCore.ts"], change: "Move the recommend call after the save and give it a timeout.",
  },
  test: {
    description: "Run the booking journey with a slow provider.", expectedIfTrue: "no booking is saved while the provider is slow",
    disprovedIf: "a booking is still saved while the provider is slow", scenario: "slow_recommendations",
  },
  confidence: 0.7,
});

test("a complete reply is a finding with its connected cases and a supported check", () => {
  const read = readFinding(complete(), known, ["slow_recommendations"]);
  assert.equal(read.ok, true);
  assert.deepEqual(read.connectedCaseIds.sort(), ["c1", "c3"]);
  assert.equal(read.evidence.length, 3);
  assert.equal(read.test.scenario, "slow_recommendations");
});

test("a scenario the app cannot run is dropped, the finding stays", () => {
  const read = readFinding(complete(), known, []);
  assert.equal(read.ok, true);
  assert.equal(read.test.scenario, undefined);
});

for (const [part, mutate, expected] of [
  ["hypothesis", (r) => { r.hypothesis = "Something is wrong."; }, /concrete hypothesis/],
  ["evidence as prose", (r) => { r.evidence = [{ ref: "the logs", says: "it failed" }, { ref: "e1", says: "failed" }]; }, /evidence/],
  ["evidence from one case", (r) => { r.evidence = [{ ref: "e1", says: "a" }, { ref: "c1", says: "b" }, { ref: "n1", says: "c" }]; }, /two cases/],
  ["an unbounded change", (r) => { r.change.scope = ["a", "b", "c", "d"]; }, /bounded change/],
  ["a rewrite-sized change", (r) => { r.change.change = "x".repeat(2000); }, /bounded change/],
  ["a change kind", (r) => { r.change.kind = "recovery"; }, /bounded change/],
  ["a disproving test", (r) => { r.test = { description: "Watch it." }; }, /disprove/],
  ["a test whose outcomes do not differ", (r) => { r.test.disprovedIf = r.test.expectedIfTrue; }, /disprove/],
]) {
  test(`a reply missing ${part} is not a finding`, () => {
    const reply = complete();
    mutate(reply);
    const read = readFinding(reply, known, ["slow_recommendations"]);
    assert.equal(read.ok, false);
    assert.equal(read.missing.length, 1);
    assert.match(read.missing[0], expected);
  });
}

test("an empty reply misses all four parts", () => {
  assert.equal(readFinding(null, known).missing.length, 4);
});

test("scenario checks exist only for plain journey-check URLs", () => {
  assert.equal(scenarioUrl("https://x.convex.site/booking-demo/journey-check", "slow_recommendations"), "https://x.convex.site/booking-demo/journey-check?scenario=slow_recommendations");
  assert.equal(scenarioUrl("https://x.convex.site/booking-demo/health", "slow_recommendations"), null);
  assert.equal(scenarioUrl("https://x.convex.site/booking-demo/journey-check?scenario=a", "slow_recommendations"), null);
});

test("a prevention check's failed first run says where it stopped, without the app's error code", async () => {
  const { createLoader } = await import("./fixtures/convex-memory.mjs");
  const { failedRunWords } = createLoader()("convex/structural/checks.ts");
  assert.equal(failedRunWords("recommendations"), 'Its first run failed at the "recommendations" step.');
  assert.equal(failedRunWords(undefined), "Its first run failed.");
  const source = (await import("node:fs")).readFileSync(new URL("../convex/structural/checks.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /error\?\.code/);
});
