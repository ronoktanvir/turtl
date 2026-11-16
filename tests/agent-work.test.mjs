import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRunLogText, mapAgentWork, money, withAgentRuns } from "../data/live/agentWork.ts";

const run = (fields = {}) => ({
  _id: "run-1", _creationTime: 1000, caseId: "case-1", stepId: "step-investigate", stepAttemptId: "attempt-1",
  taskType: "diagnose_outage", config: { modelId: "gpt-5.4-mini", reasoning: "low", harnessVersion: "h", promptVersion: "p" },
  taskCharacteristics: { complexity: "", risk: "", framework: "", repositoryArea: "" }, contextRefs: [],
  routingReason: "Quick look: the failure reproduces and points at one place.", status: "completed", corrections: [],
  routing: { configKey: "quick", configLabel: "Quick look", provider: "openai" }, costUsd: 0.0012, durationMs: 1400, ...fields,
});
const steps = [{ _id: "step-investigate", key: "investigate" }, { _id: "step-verify", key: "verify" }];

test("a handed-up pair shows both directions, the reason, cost, duration and outcome", () => {
  const quick = run({ routing: { configKey: "quick", configLabel: "Quick look", provider: "openai", escalatedToRunId: "run-2", handoff: "It showed what failed but not why." }, outcome: "failed" });
  const careful = run({ _id: "run-2", _creationTime: 2000, config: { modelId: "gpt-6.1-sol", reasoning: "high", harnessVersion: "h", promptVersion: "p" },
    routingReason: "Careful review: handed up.", routing: { configKey: "careful", configLabel: "Careful review", provider: "openai", escalatedFromRunId: "run-1" },
    costUsd: 0.02, durationMs: 38000, outcome: undefined, outcomeReason: undefined });
  const work = mapAgentWork({ steps, runs: [careful, quick], council: null });
  assert.deepEqual(work.runs.map((item) => [item.configuration, item.handedUpFrom, item.handedUpTo]), [
    ["Quick look", undefined, "Careful review"], ["Careful review", "Quick look", undefined],
  ]);
  assert.equal(work.runs[1].model, "gpt-6.1-sol (high reasoning)");
  const text = agentRunLogText(work.runs[0]);
  assert.match(text, /^Quick look · gpt-5\.4-mini \(low reasoning\) · completed/);
  assert.match(text, /Why: Quick look: the failure reproduces/);
  assert.match(text, /Handed its evidence up to the careful review\./);
  assert.match(text, /Cost under 1¢ · took 1 s/);
  assert.match(text, /Outcome: Did not establish the cause\./);
  assert.match(agentRunLogText(work.runs[1]), /Outcome: not known yet\./);
  assert.equal(money(0.12), "$0.12");
});

test("an infrastructure failure is labelled as such and never as a wrong diagnosis", () => {
  const work = mapAgentWork({ steps, runs: [run({ status: "failed", outcome: "infra_failure", error: "No model answered: gpt-5.4-mini returned HTTP 503." })], council: null });
  assert.match(agentRunLogText(work.runs[0]), /Infrastructure failure, not counted against it/);
});

test("agent runs enrich the Logs tab line and the matching plan step only", () => {
  const detail = {
    id: "case-1", logs: [{ id: "agent:run-1", at: 1000, level: "info", source: "Agent run · diagnose_outage", text: "completed (gpt-5.4-mini)" }],
    enactment: { fixKey: "f", state: "running", steps: [{ key: "investigate", title: "Investigate", status: "done" }, { key: "verify", title: "Verify", status: "pending" }] },
  };
  const out = withAgentRuns(detail, [run()], steps);
  assert.equal(out.logs[0].source, "Agent run · Quick look");
  assert.match(out.logs[0].text, /Why: /);
  assert.equal(out.enactment.steps[0].agents.length, 1);
  assert.equal(out.enactment.steps[1].agents, undefined);
  assert.equal(withAgentRuns(detail, [], steps), detail);
});

test("the council view keeps the notice that agreement is not proof", () => {
  const council = {
    _id: "review-1", _creationTime: 1, appId: "app-1", caseId: "case-1", stepId: "step-investigate", stepAttemptId: "attempt-1",
    purpose: "diagnosis", question: "Why?", status: "completed", notice: "Agreement between them is not proof.", costUsd: 0.03, startedAt: 5,
    members: [{ provider: "openai", model: "gpt-5.5", label: "gpt-5.5 (medium reasoning)", status: "answered", hypothesis: "Store down.", confidence: 0.9, supportingEvidenceIds: [], missingEvidence: [] },
      { provider: "anthropic", model: "claude-sonnet-4-5", label: "claude-sonnet-4-5", status: "not_run", supportingEvidenceIds: [], missingEvidence: [], error: "Joins when ANTHROPIC_API_KEY is set on the deployment." }],
    consolidation: { source: "model", summary: "They agree.", agreements: ["a"], disagreements: [], missingEvidence: ["m"] },
  };
  const work = mapAgentWork({ steps, runs: [], council });
  assert.equal(work.council.notice, "Agreement between them is not proof.");
  assert.deepEqual(work.council.missingEvidence, ["m"]);
  assert.equal(work.council.members[1].note, "Joins when ANTHROPIC_API_KEY is set on the deployment.");
});
