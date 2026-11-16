import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("enacting.tsx", readFileSync(new URL("../app/review/[caseId]/enacting.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function evaluate(name, values = {}) {
  let expression;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer?.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `${name} must come from the actual screen`);
  return runInNewContext(`(${expression})`, values);
}

const ready = {
  fix: { delivery: "pull_request" },
  e: { state: "waiting_for_merge", steps: [] },
  pr: { state: "open", checks: "passing", mergeable: true, checkRuns: [] },
  passed: 0,
};

test("PR-writing text uses real delivery, never an example-only plan step", () => {
  assert.equal(evaluate("ci", { ...ready, pr: undefined }), "No pull request yet");
  assert.equal(evaluate("ci", { ...ready, pr: undefined, fix: { delivery: "action" }, e: { steps: [{ key: "open_pr" }] } }), "This fix has nothing to merge");
  assert.equal(evaluate("ci", { ...ready, pr: undefined, fix: undefined }), "Pull request details not available yet");
});

test("Merge requires recorded PR delivery, open state, passing checks and mergeability", () => {
  assert.equal(evaluate("canMerge", ready), true);
  for (const change of [
    { fix: undefined }, { fix: { delivery: "action" } }, { e: { state: "running" } },
    { pr: undefined }, { pr: { ...ready.pr, state: "closed" } }, { pr: { ...ready.pr, state: "merged" } },
    { pr: { ...ready.pr, checks: "pending" } }, { pr: { ...ready.pr, checks: "failing" } },
    { pr: { ...ready.pr, checks: "none" } }, { pr: { ...ready.pr, mergeable: false } },
  ]) assert.equal(evaluate("canMerge", { ...ready, ...change }), false);
});

test("merged text does not claim live verification started before deployment", () => {
  assert.equal(evaluate("states").merged.word, "Pull request merged");
});
