import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { layoutWorkflow } from "../data/workflow.ts";
import { mapWorkflow } from "../data/live/workflowMapping.ts";
import { recordedWorkflow } from "./fixtures/workflow-recorded.ts";

test("workflow adapter preserves loading, absent, empty and literal recorded states", () => {
  assert.equal(mapWorkflow(undefined), undefined);
  assert.equal(mapWorkflow(null), null);
  assert.deepEqual(mapWorkflow({ _id: "empty", steps: [] }), { caseId: "empty", steps: [] });
  for (const scenario of ["running", "waiting", "failed", "skipped", "legacy"]) {
    const record = recordedWorkflow(scenario);
    const workflow = mapWorkflow(record);
    assert.deepEqual(workflow.steps.map((s) => [s.key, s.purpose, s.dependsOn, s.status]), record.steps.map((s) => [s.key, s.purpose, s.dependsOn, s.status]));
    for (const [index, step] of workflow.steps.entries()) {
      const attempt = record.steps[index].currentAttempt;
      assert.equal(step.currentAttempt?.attempt, attempt?.attempt);
      assert.equal(step.currentAttempt?.startedAt, attempt?.startedAt);
      assert.equal(step.currentAttempt?.finishedAt, attempt?.finishedAt);
      assert.deepEqual(step.currentAttempt?.inputRefs, attempt?.inputRefs);
      assert.deepEqual(step.currentAttempt?.outputRefs, attempt?.outputRefs);
    }
  }
});

test("adapter selects safe metadata rather than arbitrary attempt output or credentials", () => {
  const record = recordedWorkflow("joined");
  const original = structuredClone(record);
  record.steps[0].currentAttempt.output = { token: "private-payload" };
  record.steps[0].staged = { fail: 1 };
  const mapped = mapWorkflow(record);
  assert.doesNotMatch(JSON.stringify(mapped), /private-payload|staged/);
  mapped.steps[0].dependsOn.push("other");
  mapped.steps[0].currentAttempt.inputRefs.push("other");
  assert.deepEqual(record.steps[0].dependsOn, original.steps[0].dependsOn);
  assert.deepEqual(record.steps[0].currentAttempt.inputRefs, original.steps[0].currentAttempt.inputRefs);
});

test("dependency topology, not response order or status, makes the fan-out and join", () => {
  const workflow = mapWorkflow(recordedWorkflow("running"));
  const graph = layoutWorkflow(workflow.steps);
  assert.deepEqual(graph.layers.map((layer) => layer.map((s) => s.key).sort()), [["detect"], ["app-state", "error-window"], ["gather"], ["investigate"]]);
  assert.deepEqual(graph.edges.map((e) => `${e.from}>${e.to}`).sort(), [
    "step-detect>step-app-state", "step-detect>step-error-window", "step-app-state>step-gather", "step-error-window>step-gather", "step-gather>step-investigate",
  ].sort());
  assert.deepEqual(graph.issues, []);
  assert.deepEqual(graph.unresolved, []);
  assert.deepEqual(layoutWorkflow([...workflow.steps].reverse()).layers.map((layer) => layer.map((s) => s.key).sort()), graph.layers.map((layer) => layer.map((s) => s.key).sort()));
});

test("legacy linear workflows stay linear; no collectors or dependencies are invented", () => {
  const graph = layoutWorkflow(mapWorkflow(recordedWorkflow("legacy")).steps);
  assert.deepEqual(graph.layers.map((layer) => layer.map((s) => s.key)), [["detect"], ["gather"], ["investigate"]]);
  assert.equal(graph.edges.length, 2);
});

test("all declared edges survive additional branches, disconnected roots and non-adjacent dependencies", () => {
  const steps = mapWorkflow(recordedWorkflow("legacy")).steps;
  const root = { ...steps[0], id: "root-2", key: "root-2" };
  const branch = { ...steps[1], id: "branch", key: "branch", dependsOn: ["detect", "root-2"] };
  const end = { ...steps[2], dependsOn: ["detect", "gather", "branch"] };
  const graph = layoutWorkflow([end, branch, root, ...steps.slice(0, 2)]);
  assert.equal(graph.edges.length, 6);
  assert.deepEqual(graph.layers.map((layer) => layer.map((s) => s.key).sort()), [["detect", "root-2"], ["branch", "gather"], ["investigate"]]);
  assert.equal(graph.edges.some((e) => e.from === "step-detect" && e.to === "step-investigate"), true);
});

test("missing dependencies and cycles remain unordered with recorded states and real edges", () => {
  const workflow = mapWorkflow(recordedWorkflow("malformed"));
  const graph = layoutWorkflow(workflow.steps);
  assert.deepEqual(graph.layers, []);
  assert.deepEqual(graph.unresolved, workflow.steps);
  assert.match(graph.issues.join(" "), /missing dependency not-recorded/);
  assert.match(graph.issues.join(" "), /cycle/);
  assert.deepEqual(graph.edges, [{ from: "step-b", to: "step-a" }, { from: "step-a", to: "step-b" }]);
  assert.deepEqual(graph.unresolved.map((s) => s.status), ["waiting", "failed", "skipped"]);
});

test("partial graphs order only provable roots and do not attach a missing parent to the previous row", () => {
  const malformed = mapWorkflow(recordedWorkflow("malformed"));
  const root = mapWorkflow(recordedWorkflow("legacy")).steps[0];
  const graph = layoutWorkflow([root, ...malformed.steps]);
  assert.deepEqual(graph.layers, [[root]]);
  assert.equal(graph.edges.some((edge) => edge.from === root.id), false);
  const duplicate = { ...root, id: "duplicate" };
  const ambiguous = layoutWorkflow([root, duplicate, { ...malformed.steps[0], dependsOn: [root.key] }]);
  assert.equal(ambiguous.edges.length, 0);
  assert.equal(ambiguous.unresolved.length, 3);
  assert.match(ambiguous.issues.join(" "), /Duplicate step key/);
});

test("dedicated live hook and Overview do not depend on approval or example timers", () => {
  const hook = readFileSync(new URL("../data/live/workflow.ts", import.meta.url), "utf8");
  assert.match(hook, /useLiveQuery\(api\.cases\.get/);
  const index = readFileSync(new URL("../data/index.ts", import.meta.url), "utf8");
  assert.match(index, /useWorkflow = isLiveData \? live\.useWorkflow : .*=> null/);
  const page = readFileSync(new URL("../components/fix/CasePage.tsx", import.meta.url), "utf8");
  assert.match(page, /const workflow = useWorkflow\(caseId\)/);
  assert.match(page, /isLiveData && \(workflow \? <WorkflowGraph/);
  const graph = readFileSync(new URL("../components/execution/WorkflowGraph.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(graph, /setInterval|setTimeout|useEnactmentNow|estimatedDuration/);
});
