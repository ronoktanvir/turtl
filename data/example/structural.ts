import type { StructuralFinding } from "../types";

export const listenerStructural: StructuralFinding = {
  id: "listener-ladder-structural-1",
  projectId: "listener-ladder",
  caseId: "listener-ladder-1",
  caseTitle: "Answers time out before the next round",
  hypothesis: "Global ranking is optional for a round, but it sits on the answer's write path. The answer is not saved until a rank over the whole score history is ready, so any slowdown in ranking stops play.",
  evidence: [
    { text: "Every answer waits for historyRank before it is saved.", label: "lib/game.ts", kind: "codeNode", cite: "cite-rank-wait" },
    { text: "All six answers and retries timed out with the large score history.", label: "Builder evidence", kind: "evidence", cite: "cite-browser-evidence" },
    { text: "Timed-out ranking work still holds database connections while the next answer waits.", label: "Review database work after the answer deadline", kind: "case" },
  ],
  change: { title: "Decouple ranking from gameplay", kind: "repair", fixKey: "listener_decouple_ranking" },
  test: {
    description: "Slow ranking past its time limit and complete several rounds with the same large score history.",
    disprovedIf: "rounds still time out while ranking is turned off, which would mean something else on the answer path is slow.",
  },
  confidence: 0.72,
  connectedCaseCount: 3,
  seededCaseCount: 0,
  check: {
    name: "Answer while ranking is slow",
    description: "Runs the answer journey with the game's live settings, but with ranking slowed past its time limit for this one run. It fails while a slow ranking would stop players from continuing.",
    status: "offered",
  },
  foundAt: Date.parse("2026-11-15T09:00:00Z"),
};
