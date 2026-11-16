import { api } from "../../convex/_generated/api";
import type { AgentWork, CaseDetail } from "../types";
import { mapAgentWork, withAgentRuns } from "./agentWork";
import { mapCaseDetail } from "./caseMapping";
import { useLiveQuery } from "./client";
import { useCaseNumber } from "./projects";

export function useCase(caseId: string): CaseDetail | null | undefined {
  const cards = useLiveQuery(api.cases.cards, caseId ? { id: caseId } : "skip");
  const loadedId = cards?.case._id;
  const fixes = useLiveQuery(api.fixes.forCase, loadedId ? { caseId: loadedId } : "skip");
  const pullRequest = useLiveQuery(api.pullRequests.forCase, loadedId ? { caseId: loadedId } : "skip");
  const screenshots = useLiveQuery(api.revyl.runs.screenshots, loadedId ? { caseId: loadedId } : "skip");
  const reports = useLiveQuery(api.intake.records.forCase, loadedId && cards?.case.raisedBy === "customer" ? { caseId: loadedId } : "skip");
  const structural = useLiveQuery(api.structural.queries.forCase, loadedId ? { caseId: loadedId } : "skip");
  const number = useCaseNumber(caseId);
  if (!caseId) return null;
  if (cards === undefined || cards === null) return cards;
  return withAgentRuns(mapCaseDetail(cards, fixes, pullRequest, screenshots, number, reports, structural), cards.agentRuns, cards.steps);
}

export function useAgentWork(caseId: string): AgentWork | null | undefined {
  const view = useLiveQuery(api.routing.view.forCase, caseId ? { caseId } : "skip");
  if (!caseId) return null;
  if (view === undefined || view === null) return view;
  return mapAgentWork(view);
}
