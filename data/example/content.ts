import type { CaseDetail, CodeNetwork, FixOption, Project, PullRequest, Screenshot } from "../types";
import { listenerProject, listenerCases, listenerNetwork, listenerPlans, listenerProposals, listenerReplies, listenerAfterShots } from "./listener-ladder";
import { listenerFeatures, featurePlans, featureReplies, featureAfterShots } from "./listener-features";
import { withExampleInstructions, withExampleSends } from "./instructions";
import { listenerStructural } from "./structural";
import { practiceLearned, practicePlans } from "./practice";

export type ProjectSeed = Pick<Project, "id" | "name" | "iconUrl" | "summary" | "repoUrl" | "productionUrl" | "approvals" | "practice">;
export type StepSeed = {
  key: string;
  title: string;
  detail: string;
  summary: string;
  effect?: "open_pr" | "checks" | "merge_gate";
  question?: { text: string; fixes: FixOption[] };
};

export const projectSeeds: ProjectSeed[] = [
  listenerProject,
  { id: "orca", name: "Orca", summary: "A hierarchical RL system that orchestrates multi-agent teams.", approvals: "you" },
  { id: "superprediction", name: "Superprediction", summary: "Continual learning over prediction markets. A self-distilling forecaster that learns from being wrong.", approvals: "you" },
  { id: "guardian", name: "Guardian", summary: "AI-powered fraud detection with real-time transaction scoring and explainable alerts.", approvals: "you" },
];

const request = (projectId: string, number: number, title: string, summary: string): CaseDetail => ({
  id: `${projectId}-request-${number}`, projectId, type: "feature", number, title, category: "feature_request", status: "new", health: "clear", happenedAt: Date.now() - number * 86_400_000,
  summary, overview: [{ kind: "paragraph", spans: [{ text: summary }] }], citations: [], logs: [], code: [], screenshots: [], fixes: [],
});

export const caseSeeds: CaseDetail[] = [
  ...listenerCases.map((item) => withExampleSends(item.id === listenerStructural.caseId ? { ...item, structural: listenerStructural } : item)),
  ...listenerFeatures.map(withExampleSends),
  request("orca", 1, "Compare agent team performance", "A request to compare team outcomes across tasks. No implementation plan has been prepared yet."),
  request("superprediction", 1, "Compare forecast revisions", "A request to see how a forecast changes as new evidence arrives. No implementation plan has been prepared yet."),
  request("superprediction", 2, "Explain a missed prediction", "A request to review the evidence behind an incorrect forecast. No implementation plan has been prepared yet."),
  request("guardian", 1, "Export alert evidence", "A request to export the evidence behind a flagged transaction. No implementation plan has been prepared yet."),
];

export const networks: Record<string, CodeNetwork> = { "listener-ladder": listenerNetwork };
export const proposals = Object.fromEntries(Object.entries(listenerProposals).map(([id, proposal]) => [id, { ...proposal, fix: withExampleInstructions(proposal.fix) }]));
export const caseReplies: Record<string, string[]> = { ...listenerReplies, ...featureReplies, default: ["This request has not been investigated yet. There is no implementation plan to approve."] };
export const headChangesOnce = listenerCases.filter((item) => item.health === "needs_you").flatMap((item) => item.fixes.slice(0, 1).map((fix) => fix.key));

export function planFor(fix: FixOption): StepSeed[] {
  return practicePlans[fix.key] ?? featurePlans[fix.key] ?? listenerPlans[fix.key] ?? [
    { key: "write", title: "Write the change", detail: fix.whatChanges, summary: "The proposed change is ready for review." },
    { key: "open_pr", title: "Open a pull request", detail: "The change stays on its own branch until you merge.", summary: "Pull request opened.", effect: "open_pr" },
    { key: "checks", title: "Run the checks", detail: fix.howChecked, summary: "The checks passed.", effect: "checks" },
    { key: "merge", title: "Merge and deploy", detail: "This step waits for your decision.", summary: "Merged and deployed.", effect: "merge_gate" },
    { key: "verify", title: "Verify the player journey", detail: "Check that answers advance the round and completed scores are saved once.", summary: "The player journey completed." },
  ];
}

export function pullRequestFor(item: CaseDetail, fix: FixOption): PullRequest {
  const repo = "aryan-gupta123/listener-ladder-demo";
  return { repo, number: item.number + 40, title: fix.title, url: `https://github.com/${repo}/pull/${item.number + 40}`, headSha: "7d3a9f2", state: "open", checks: "pending", checkRuns: [{ name: "Typecheck", status: "pending" }, { name: "Tests", status: "pending" }, { name: "Player journey", status: "pending" }], mergeable: false };
}

export function learnedFor(fix: FixOption): string {
  if (practiceLearned[fix.key]) return practiceLearned[fix.key];
  return `${fix.title} lets the game advance without scanning the entire score history on every answer.`;
}

export function afterShots(caseId: string): Screenshot[] {
  return caseId === "listener-ladder-1" ? listenerAfterShots() : featureAfterShots(caseId);
}
