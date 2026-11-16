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

const { enactmentControls } = await import("../components/execution/controls.ts");
// An explicit undefined means "none", so the defaults apply only to what a case leaves out.
const controls = (change = {}) => {
  const { fix, e, pr } = { fix: ready.fix, e: ready.e, pr: ready.pr, ...change };
  return enactmentControls({ ...e, pullRequest: pr }, fix);
};

test("PR-writing text uses real delivery, never an example-only plan step", () => {
  assert.equal(controls({ pr: undefined, e: { state: "running" } }).status, "No pull request yet");
  assert.equal(controls({ pr: undefined, fix: { delivery: "action" }, e: { state: "running", steps: [{ key: "open_pr" }] } }).status, null, "a setting change has nothing to merge, so nothing is said about merging");
  assert.equal(controls({ pr: undefined, fix: undefined }).status, null);
});

test("Merge requires recorded PR delivery, open state, passing checks and mergeability", () => {
  assert.equal(controls().merge, "enabled");
  for (const change of [{ e: { state: "running" } }, { pr: { ...ready.pr, checks: "pending" } }, { pr: { ...ready.pr, checks: "failing" } }, { pr: { ...ready.pr, checks: "none" } }, { pr: { ...ready.pr, mergeable: false } }]) {
    assert.equal(controls(change).merge, "waiting", JSON.stringify(change));
  }
  for (const change of [{ fix: undefined }, { fix: { delivery: "action" } }, { pr: undefined }, { pr: { ...ready.pr, state: "closed" } }, { pr: { ...ready.pr, state: "merged" } }]) {
    assert.equal(controls(change).merge, null, JSON.stringify(change));
  }
});

test("a finished fix shows no Stop, and a setting change never shows Merge", () => {
  for (const state of ["done", "merged", "stopped", "failed"]) assert.equal(controls({ e: { state } }).stop, false, state);
  for (const state of ["running", "needs_you", "waiting_for_merge"]) assert.equal(controls({ e: { state } }).stop, true, state);
  assert.deepEqual(controls({ fix: { delivery: "action" }, pr: undefined, e: { state: "done" } }), { stop: false, merge: null, status: null }, "a finished setting change shows neither");
  assert.deepEqual(controls({ fix: { delivery: "action" }, pr: undefined, e: { state: "running" } }), { stop: true, merge: null, status: null });
  const screen = readFileSync(new URL("../app/review/[caseId]/enacting.tsx", import.meta.url), "utf8");
  assert.match(screen, /\{controls\.stop && <Button/);
  assert.match(screen, /\{controls\.merge && <Button/);
});

test("merged text does not claim live verification started before deployment", () => {
  assert.equal(evaluate("states").merged.word, "Pull request merged");
});
