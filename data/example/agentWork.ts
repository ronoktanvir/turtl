import { agentRunLogText } from "../live/agentWork";
import type { AgentRunView, AgentWork, CaseDetail } from "../types";

const evidenceDay = Date.parse("2026-11-15T08:00:00Z");

// Who worked on the example cases and why. The same story the live router tells: a quick look that could not say why
// handed its evidence up, the careful review stayed unsure, and a council of models read the same evidence.

const quick: AgentRunView = {
  id: "ll-run-quick", stepKey: "investigate", task: "diagnosis", configuration: "Quick look", model: "gpt-5.4-mini (low reasoning)",
  reason: "Quick look: the failure reproduces and points at one place; this failure has not been seen in a verified case before, which alone is not enough to need a careful review.",
  handedUpTo: "Careful review",
  handoff: "The quick look could not establish a cause: it rests only on the failure's own symptoms, which show what failed but not why. Its reading was: \"Answers return HTTP 504 after two seconds, so rounds cannot continue.\" (confidence 95%).",
  status: "completed", outcome: "failed", outcomeReason: "Handed up: it showed what failed but not why.",
  costUsd: 0.0012, durationMs: 1_400, startedAt: evidenceDay + 60_000,
};

const careful: AgentRunView = {
  id: "ll-run-careful", stepKey: "investigate", task: "diagnosis", configuration: "Careful review", model: "gpt-6.1-sol (high reasoning)",
  reason: "Careful review: handed up from the quick look, which could not say why answers time out.",
  handedUpFrom: "Quick look",
  status: "completed", outcomeReason: "Outcome not known yet: no fix has been approved and verified.",
  costUsd: 0.021, durationMs: 38_000, startedAt: evidenceDay + 62_000,
};

const member = (id: string, model: string, costUsd: number, durationMs: number): AgentRunView => ({
  id, stepKey: "investigate", task: "council_member", configuration: "Council member", model: model + " (medium reasoning)",
  reason: "Council: the careful diagnosis was still unsure and no remembered recovery applied, so 3 models read the same evidence independently.",
  status: "completed", costUsd, durationMs, startedAt: evidenceDay + 101_000,
});

export const exampleAgentWork: Record<string, AgentWork> = {
  "listener-ladder-1": {
    runs: [quick, careful, member("ll-run-c1", "gpt-6.1-sol", 0.004, 4_600), member("ll-run-c2", "gpt-5.5", 0.018, 6_900), member("ll-run-c3", "gpt-6.1-terra", 0.0025, 4_700)],
    council: {
      id: "ll-council", status: "completed", startedAt: evidenceDay + 101_000, costUsd: 0.03,
      notice: "Several models read the same evidence on their own. Agreement between them is not proof: they can share the same missing evidence. Nothing here was verified, and it approves nothing.",
      summary: "The reviewers agree that each answer reads the whole score history before it can rank the player, which outlasts the two-second deadline. They differ on whether waiting for a database connection adds to the delay. Agreement between them is not proof, and nothing has been verified.",
      agreements: [
        "Each answer fetched hundreds of thousands of scores (811,500 rows in 3,246 pages) before its deadline expired.",
        "With a small history the same journey passes, so the size of the history matters.",
      ],
      disagreements: [
        "Reviewer A says the full-history read alone explains the timeout; Reviewer C thinks waiting for one of the five database connections may add to it.",
      ],
      missingEvidence: [
        "How long each part of an answer takes: the history read, the ranking and the save.",
        "How many database connections were in use while answers timed out.",
      ],
      members: [
        { label: "gpt-6.1-sol (medium reasoning)", status: "answered", confidence: 0.8, hypothesis: "Each answer ranks the player by reading the full score history, which takes longer than the two-second deadline once the history is large." },
        { label: "gpt-5.5 (medium reasoning)", status: "answered", confidence: 0.75, hypothesis: "The answer path scans every saved score to compute a rank; with 1.6 million scores this outlasts the deadline." },
        { label: "gpt-6.1-terra (medium reasoning)", status: "answered", confidence: 0.6, hypothesis: "The full-history read is slow, and answers may also wait for a database connection from the pool of five." },
        { label: "claude-sonnet-4-5", status: "not_run", note: "Joins when ANTHROPIC_API_KEY is set on the deployment." },
        { label: "gemini-2.5-pro", status: "not_run", note: "Joins when GEMINI_API_KEY is set on the deployment." },
      ],
    },
  },
};

export function withExampleAgentRuns(detail: CaseDetail | null | undefined): CaseDetail | null | undefined {
  const work = detail && exampleAgentWork[detail.id];
  if (!detail || !work) return detail;
  const logs = [
    ...detail.logs,
    ...work.runs.map((run) => ({ id: `agent:${run.id}`, at: run.startedAt, level: "info" as const, source: `Agent run · ${run.configuration}`, text: agentRunLogText(run) })),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const enactment = detail.enactment && {
    ...detail.enactment,
    steps: detail.enactment.steps.map((step) => {
      const agents = work.runs.filter((run) => run.stepKey === step.key);
      return agents.length ? { ...step, agents } : step;
    }),
  };
  return { ...detail, logs, ...(enactment && { enactment }) };
}
