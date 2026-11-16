import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deeperCauseTitle, reportLine } from "../components/fix/counts.ts";

// The counts on an opened case agree with their number: "1 people reported it" and "across 1 cases" were shown.

test("under a case's summary, one person or one report reads in the singular", () => {
  assert.equal(reportLine(1, true), "1 person asked");
  assert.equal(reportLine(3, true), "3 people asked");
  assert.equal(reportLine(1, false), "1 customer report");
  assert.equal(reportLine(2, false), "2 customer reports");
});

test("a deeper cause found on one case does not claim to span cases", () => {
  assert.equal(deeperCauseTitle(1), "A deeper cause behind this case");
  assert.equal(deeperCauseTitle(0), "A deeper cause behind this case");
  assert.equal(deeperCauseTitle(4), "A deeper cause across 4 cases");
});

test("the case page and the finding card use these words", () => {
  const page = readFileSync(new URL("../components/fix/CasePage.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../components/fix/StructuralFinding.tsx", import.meta.url), "utf8");
  assert.match(page, /reportLine\(c\.reportCount, feature\)/);
  assert.doesNotMatch(page, /people reported it/);
  assert.match(card, /deeperCauseTitle\(finding\.connectedCaseCount\)/);
});
