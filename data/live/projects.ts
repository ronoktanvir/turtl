import { api } from "../../convex/_generated/api";
import type { CaseType, Project } from "../types";
import { useLiveQuery } from "./client";
import { mapCaseSummary } from "./caseMapping";

const closed = new Set(["restored", "resolved", "declined"]);
const healthOrder = ["affected", "needs_you", "working", "clear"] as const;

function useRows() {
  return useLiveQuery(api.screens.projects.list, {});
}

export function useProjects(): Project[] | undefined {
  const rows = useRows();
  return rows?.map(({ app, cases, approvals }) => {
    const open = cases.filter((row) => !closed.has(row.status));
    const summaries = open.map((row) => mapCaseSummary(row, 0, row.pullRequest));
    return {
      id: app._id,
      name: app.name,
      repoUrl: app.repoUrl,
      productionUrl: app.productionUrl,
      approvals,
      health: healthOrder.find((health) => summaries.some((row) => row.health === health)) ?? "clear",
      bugCount: open.filter((row) => row.kind !== "feature_request").length,
      featureCount: open.filter((row) => row.kind === "feature_request").length,
      needsApprovalCount: summaries.filter((row) => row.status === "needs_approval" || row.status === "ready_to_merge").length,
    };
  });
}

export function useProject(projectId: string) {
  const projects = useProjects();
  return projects === undefined ? undefined : projects.find((project) => project.id === projectId) ?? null;
}

export function useCases(projectId: string, type: CaseType) {
  const rows = useRows();
  if (rows === undefined) return undefined;
  const cases = rows.find((row) => row.app._id === projectId)?.cases ?? [];
  return [...cases].sort((a, b) => a._creationTime - b._creationTime)
    .filter((row) => (row.kind === "feature_request" ? "feature" : "fix") === type)
    .map((row, i) => ({ row, summary: mapCaseSummary(row, i + 1, row.pullRequest) }))
    .filter(({ row }) => !closed.has(row.status))
    .map(({ summary }) => summary).reverse();
}

export function useCaseNumber(caseId: string): number | undefined {
  const rows = useRows();
  const cases = rows?.find((row) => row.cases.some((item) => item._id === caseId))?.cases;
  const selected = cases?.find((row) => row._id === caseId);
  if (!cases || !selected) return undefined;
  return [...cases].filter((row) => (row.kind === "feature_request") === (selected.kind === "feature_request"))
    .sort((a, b) => a._creationTime - b._creationTime).findIndex((row) => row._id === caseId) + 1;
}

export function useApprovalSettings(projectId: string) {
  const data = useLiveQuery(api.screens.projects.approvalSettings, projectId ? { projectId } : "skip");
  return {
    loading: data === undefined,
    active: data?.active ?? false,
    canEnable: data?.canEnable ?? false,
    reason: data?.reason ?? "No scoped recovery permission is available for this project.",
    scope: data?.scope,
  };
}
