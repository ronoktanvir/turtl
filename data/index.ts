import { useMemo, useSyncExternalStore } from "react";
import * as store from "./example/store";
import type {
  ApprovalMode,
  CaseDetail,
  CaseSummary,
  CaseType,
  ChatMessage,
  ChatScope,
  CodeNetwork,
  Project,
} from "./types";

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
  useVersion();
  return store.getCase(caseId);
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
