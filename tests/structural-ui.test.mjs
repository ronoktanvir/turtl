import assert from "node:assert/strict";
import { test } from "node:test";
import { mapCaseDetail } from "../data/live/caseMapping.ts";

const row = { _id: "case-1", _creationTime: 1000, appId: "app-1", title: "Booking failed", impact: "A test booking could not be saved.", kind: "outage", raisedBy: "monitor", status: "investigating" };
const attempt = { _id: "attempt-1", _creationTime: 1200, stepId: "step-1", caseId: "case-1", attempt: 1, status: "done", startedAt: 1200, finishedAt: 1400, summary: "Observed the failure.",
  output: { diagnosis: { cause: "Booking waits on recommendations.", source: "model", supportingEvidenceIds: [] } } };
const step = { _id: "step-1", _creationTime: 1100, caseId: "case-1", key: "investigate", title: "Investigate", dependsOn: [], kind: "agent", purpose: "investigate", status: "done", currentAttempt: attempt };
const evidence = { _id: "evidence-1", _creationTime: 1300, caseId: "case-1", stepId: "step-1", stepAttemptId: "attempt-1", kind: "http_check", title: "The check failed.", observedAt: 1250, environment: "protected-app", revision: { deploymentId: "v1" } };
const cards = { case: row, journey: null, steps: [step], executeAttempts: [], evidence: [evidence], proposal: null, action: null, verifications: [], agentRuns: [] };
const finding = (fields = {}) => ({
  id: "finding-1", projectId: "app-1", caseId: "case-1", caseTitle: "Booking failed",
  hypothesis: "Optional recommendations sit on the booking write path.",
  evidence: [
    { text: "The booking check failed at recommendations.", label: "The check failed.", kind: "evidence", cite: "evidence-1" },
    { text: "An earlier case failed the same way.", label: "Older case", kind: "evidence", cite: "evidence-from-another-case" },
    { text: "Recommendations were turned off to recover.", label: "set_feature_flag (completed)", kind: "action" },
  ],
  change: { title: "Load recommendations without blocking booking", kind: "repair", fixKey: "structural_repair" },
  test: { description: "Slow the provider and book.", disprovedIf: "booking still fails with recommendations off." },
  confidence: 0.7, connectedCaseCount: 3, seededCaseCount: 0,
  check: { name: "Book while recommendations are slow", description: "Runs the booking journey with a slow provider.", status: "offered" },
  foundAt: 2000, ...fields,
});
const texts = (detail) => detail.overview.filter((block) => block.kind === "paragraph").map((block) => block.spans.map((span) => span.text).join(""));

test("a structural finding is carried on the case, not repeated as overview paragraphs", () => {
  const without = mapCaseDetail(cards, undefined, null, [], 3);
  const detail = mapCaseDetail(cards, undefined, null, [], 3, undefined, finding());
  assert.deepEqual(detail.overview, without.overview);
  assert.equal(texts(detail).some((text) => /deeper cause/.test(text)), false);
});

test("the structural field keeps the finding with only known evidence citations", () => {
  const detail = mapCaseDetail(cards, undefined, null, [], 3, undefined, finding());
  assert.equal(detail.structural.id, "finding-1");
  assert.equal(detail.structural.hypothesis, "Optional recommendations sit on the booking write path.");
  assert.deepEqual(detail.structural.evidence.map((item) => item.cite), ["evidence-1", undefined, undefined]);
  assert.equal(detail.structural.change.fixKey, "structural_repair");
  assert.equal(detail.structural.check.status, "offered");
  assert.equal(detail.structural.connectedCaseCount, 3);
});

test("seeded related cases are counted on the finding", () => {
  assert.equal(mapCaseDetail(cards, undefined, null, [], 3, undefined, finding({ seededCaseCount: 2 })).structural.seededCaseCount, 2);
});

test("without a finding the case detail is unchanged", () => {
  const without = mapCaseDetail(cards, undefined, null, [], 3);
  assert.deepEqual(mapCaseDetail(cards, undefined, null, [], 3, undefined, null), without);
  assert.deepEqual(mapCaseDetail(cards, undefined, null, [], 3, undefined, undefined), without);
  assert.equal("structural" in without, false);
  assert.equal(texts(without).some((text) => /deeper cause/.test(text)), false);
});
