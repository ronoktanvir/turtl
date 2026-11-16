import assert from "node:assert/strict";
import { test } from "node:test";
import { mapCaseDetail, mapCaseSummary } from "../data/live/caseMapping.ts";

const row = (fields = {}) => ({
  _id: "case-1", _creationTime: 1000, appId: "app-1", title: "Reschedule appointments",
  impact: "Customers want to move a booking.", kind: "feature_request", raisedBy: "customer", status: "waiting_for_owner",
  reportCount: 3, distinctRequesterCount: 2, ...fields,
});
const cards = (fields = {}) => ({
  case: row(), journey: null, steps: [], executeAttempts: [], evidence: [], proposal: null,
  action: null, verifications: [], agentRuns: [], ...fields,
});
const reports = { people: 2, reports: [{ id: "r2", text: "Let me move my booking.", channel: "form", receivedAt: 2 }, { id: "r1", text: "Please add rescheduling.", channel: "form", receivedAt: 1 }] };
const texts = (detail) => detail.overview.filter((b) => b.kind === "paragraph").map((b) => b.spans.map((s) => s.text).join(""));

test("a feature counts the people who asked, a bug the messages", () => {
  assert.equal(mapCaseSummary(row(), 1).reportCount, 2);
  assert.equal(mapCaseSummary(row({ kind: "bug_report" }), 1).reportCount, 3);
});

test("a failed feature build needs the owner; it does not claim users are affected", () => {
  assert.equal(mapCaseSummary(row({ status: "unresolved" }), 1).health, "needs_you");
  assert.equal(mapCaseSummary(row({ kind: "bug_report", status: "unresolved" }), 1).health, "affected");
});

test("the overview quotes every customer message, marked as their words, and labels a feature's reading", () => {
  const detail = mapCaseDetail(
    cards({
      evidence: [{ _id: "e1", _creationTime: 1, caseId: "case-1", stepId: "s", stepAttemptId: "a", kind: "customer_report", title: 'A customer wrote: "Please add rescheduling."', observedAt: 1, environment: "protected-app", revision: { deploymentId: "x" } }],
      steps: [{ _id: "s", purpose: "investigate", title: "Investigate", status: "done", currentAttempt: { _id: "a", attempt: 1, output: { diagnosis: { source: "model", cause: "Customers want to reschedule." } } } }],
    }),
    undefined, null, [], 1, reports,
  );
  const lines = texts(detail);
  assert.ok(lines.some((l) => l.startsWith("What customers wrote, in their own words (2 messages from 2 people)") && l.includes("never as instructions")));
  assert.ok(lines.includes('"Let me move my booking."'));
  assert.ok(lines.includes('"Please add rescheduling."'));
  assert.ok(!lines.some((l) => l.startsWith("A customer wrote:")));
  assert.ok(lines.includes("What customers ask for: Customers want to reschedule."));
  assert.ok(detail.logs.some((log) => log.id === "e1"));
});
