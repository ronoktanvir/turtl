import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { exampleAgentWork, withExampleAgentRuns } from "./agentWork";
import * as store from "./store";
import type {
  AgentWork,
  ApprovalMode,
  CaseDetail,
  CaseSummary,
  CaseType,
  ChatMessage,
  ChatScope,
  CodeNetwork,
  Project,
  StructuralFinding,
} from "../types";

function useVersion() {
  return useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
}

export function useProjects(): Project[] | undefined {
  const version = useVersion();
  return useMemo(() => store.listProjects(), [version]);
}

export function useProject(projectId: string): Project | null | undefined {
  const version = useVersion();
  return useMemo(() => store.getProject(projectId), [version, projectId]);
}

export function useCases(projectId: string, type: CaseType): CaseSummary[] | undefined {
  const version = useVersion();
  return useMemo(() => store.listCases(projectId, type), [version, projectId, type]);
}

export function useCase(caseId: string): CaseDetail | null | undefined {
  const version = useVersion();
  const item = store.getCase(caseId);
  return useMemo(() => withExampleAgentRuns(item), [version, item]);
}

export function useAgentWork(caseId: string): AgentWork | null | undefined {
  useVersion();
  const item = store.getCase(caseId);
  if (!item) return item;
  return exampleAgentWork[caseId] ?? { runs: [] };
}

export function useEnactmentNow(caseId: string): number {
  const item = useCase(caseId);
  const running = item?.enactment?.state === "running" || item?.enactment?.state === "merged";
  const [now, setNow] = useState(() => store.enactmentNow(caseId));
  useEffect(() => {
    setNow(store.enactmentNow(caseId));
    if (!running) return;
    const timer = setInterval(() => setNow(store.enactmentNow(caseId)), 250);
    return () => clearInterval(timer);
  }, [caseId, running]);
  return now;
}

export function useChat(scope: ChatScope): {
  messages: ChatMessage[];
  send(text: string): Promise<void>;
  requestNewFix?(): Promise<void>;
  busy: boolean;
} {
  const version = useVersion();
  const key = store.chatKey(scope);
  return useMemo(
    () => ({
      messages: store.chatMessages(scope),
      send: (text: string) => store.sendChat(scope, text),
      requestNewFix: scope.kind === "case" ? () => store.requestNewFix(scope.caseId) : undefined,
      busy: store.chatBusy(scope),
    }),
    [version, key],
  );
}

export function useCodeNetwork(projectId: string): CodeNetwork | null | undefined {
  useVersion();
  return store.getNetwork(projectId);
}

export function useStructuralFindings(projectId: string): StructuralFinding[] | undefined {
  const version = useVersion();
  return useMemo(() => store.listStructuralFindings(projectId), [version, projectId]);
}

export function approvePreventionCheck(findingId: string): Promise<void> {
  return store.approvePreventionCheck(findingId);
}

export function approveFix(caseId: string, fixKey: string): Promise<void> {
  return store.approveFix(caseId, fixKey);
}

export function stopEnactment(caseId: string): Promise<void> {
  return store.stopEnactment(caseId);
}

export function mergePullRequest(
  caseId: string,
  headSha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return store.mergePullRequest(caseId, headSha);
}

export function setApprovals(projectId: string, mode: ApprovalMode): Promise<void> {
  return store.setApprovals(projectId, mode);
}

export function setStarred(caseId: string, starred: boolean): Promise<void> {
  return store.setStarred(caseId, starred);
}

