import assert from "node:assert/strict";
import { test } from "node:test";
import { issueState } from "../components/project/issueState.ts";

// The word and turtle on each card of the Fix and Features lists. A feature request is something customers
// asked for; it is never an "issue", and nothing about it is urgent in the way a broken app is.

const item = (type, status, health) => ({ type, status, health });

test("a bug that is hurting users is an urgent issue", () => {
  assert.deepEqual(issueState(item("fix", "needs_approval", "affected")), { label: "Urgent issue", color: "statusAffected", turtle: "affected" });
  assert.deepEqual(issueState(item("fix", "investigating", "affected")), { label: "Urgent issue", color: "statusAffected", turtle: "affected" });
});

test("a feature request is never called an urgent issue, whatever its health says", () => {
  assert.deepEqual(issueState(item("feature", "needs_approval", "affected")), { label: "Needs review", color: "statusReview", turtle: "review" });
  assert.deepEqual(issueState(item("feature", "enacting", "affected")), { label: "Currently working", color: "statusWorking", turtle: "working" });
  assert.deepEqual(issueState(item("feature", "new", "affected")), { label: "New request", color: "statusNew", turtle: "new" });
});

test("something nobody has looked at yet is a new issue under Fix and a new request under Features", () => {
  assert.equal(issueState(item("fix", "new", "clear")).label, "New issue");
  assert.equal(issueState(item("feature", "new", "clear")).label, "New request");
});

test("how a case ended is said before anything else, for bugs and requests alike", () => {
  for (const type of ["fix", "feature"]) {
    assert.deepEqual(issueState(item(type, "resolved", "affected")), { label: "Resolved", color: "statusClear", turtle: "clear" });
    assert.deepEqual(issueState(item(type, "declined", "affected")), { label: "Declined", color: "textMuted", turtle: "needs_you" });
    assert.deepEqual(issueState(item(type, "unresolved", "clear")), { label: "Unresolved", color: "statusAffected", turtle: "affected" });
  }
});

test("a case waiting on the owner needs review, and one turtl is on is currently working", () => {
  assert.deepEqual(issueState(item("fix", "ready_to_merge", "needs_you")), { label: "Needs review", color: "statusReview", turtle: "review" });
  assert.deepEqual(issueState(item("fix", "investigating", "working")), { label: "Currently working", color: "statusWorking", turtle: "working" });
});

test("an opened feature request shows the same request words, never a bug's", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../components/fix/CasePage.tsx", import.meta.url), "utf8");
  assert.match(page, /feature \|\| notAnswering \? <RequestState state=\{issueState\(c\)\}/);
  assert.match(page, /accessibilityLabel=\{feature \? "New request" : "New issue"\}/);
});

test("an app that is not answering turtl's checks is said so, in an urgent issue's colour and turtle", () => {
  for (const health of ["affected", "working", "clear"]) {
    assert.deepEqual(issueState(item("fix", "not_answering", health)), { label: "Not answering", color: "statusAffected", turtle: "affected" });
  }
});

test("the swipe to begin review opens the first issue there is something to review on, never a not-answering one", async () => {
  const { firstToReview } = await import("../components/project/issueState.ts");
  const quiet = { id: "q", status: "not_answering", notAnswering: true };
  const broken = { id: "b", status: "investigating" };
  assert.equal(firstToReview([quiet, broken]), "b");
  assert.equal(firstToReview([broken, quiet]), "b");
  assert.equal(firstToReview([quiet]), undefined, "nothing to review: no swipe");
  assert.equal(firstToReview([{ id: "r", status: "unresolved", notAnswering: true }]), undefined, "closed because turtl stopped checking: still nothing to review");
  assert.equal(firstToReview([{ id: "u", status: "unresolved" }]), "u");
  assert.equal(firstToReview([]), undefined);
});
