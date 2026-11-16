import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deeperCauseTitle, reportLine } from "../components/fix/counts.ts";
import { nameSize } from "../components/project/nameSize.ts";

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

test("the approval count reads the same on Projects and on a project, with no full stop on either", () => {
  const home = readFileSync(new URL("../app/project/[projectId]/index.tsx", import.meta.url), "utf8");
  const list = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(home, /approvalLabel\([a-zA-Z]+\) \+ "\."/);
  assert.match(home, /fixApprovals > 0 \? approvalLabel\(fixApprovals\) :/);
  assert.match(home, /featureApprovals > 0 \? approvalLabel\(featureApprovals\) :/);
  assert.match(list, /approvalLabel\(p\.needsApprovalCount\) :/);
});

test("a one-word project name shrinks to fit a narrow card instead of breaking mid-word", () => {
  assert.equal(nameSize("Superprediction", 226), 18, "390 wide: unchanged");
  assert.equal(nameSize("Superprediction", 156), 17, "320 wide: a little smaller");
  assert.equal(nameSize("Superprediction", 136), 15, "300 wide");
  assert.equal(nameSize("Listener Ladder", 136), 18, "names with spaces wrap between words instead");
  assert.equal(nameSize("Supercalifragilisticexpialidocious", 120), 14, "never below 14");
  const list = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
  assert.match(list, /fontSize: nameSize\(p\.name, nameColumn\)/);
});
