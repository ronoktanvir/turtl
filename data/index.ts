import { useEffect, useState } from "react";
import * as example from "./example/hooks";
import { useVoice as useExampleVoice } from "./example/voice";
import * as live from "./live";
import { useVoice as useLiveVoice } from "./live/voice";
import * as onboardingExample from "./onboarding/example";
import * as onboardingLive from "./onboarding/live";
import { liveClient } from "./live/client";
import { watchReachability } from "./live/reachability";
import { isLiveData } from "./source";

export { appEnv, isLiveData, isStoreBuild } from "./source";
export { useDataStatus } from "./live/client";
export { liveClient as backendClient } from "./live/client";
export function useBackendReachable(): boolean {
  const [reachable, setReachable] = useState(true);
  useEffect(() => (liveClient ? watchReachability(liveClient, setReachable) : undefined), []);
  return reachable;
}
export const useProjects = isLiveData ? live.useProjects : example.useProjects;
export const useProject = isLiveData ? live.useProject : example.useProject;
export const useCases = isLiveData ? live.useCases : example.useCases;
export const useCase = isLiveData ? live.useCase : example.useCase;
export const useAgentWork = isLiveData ? live.useAgentWork : example.useAgentWork;
export { money as formatAgentCost, seconds as formatAgentDuration } from "./live/agentWork";
export const useWorkflow = isLiveData ? live.useWorkflow : (_caseId: string): import("./workflow").Workflow | null => null;
export const useChat = isLiveData ? live.useChat : example.useChat;
export const useVoice = isLiveData ? useLiveVoice : useExampleVoice;
export const useCodeNetwork = isLiveData ? live.useCodeNetwork : example.useCodeNetwork;
export const useEnactmentNow = isLiveData ? live.useEnactmentNow : example.useEnactmentNow;
export const approveFix = isLiveData ? live.approveFix : example.approveFix;
export const declineFixes = isLiveData ? live.declineFixes : example.declineFixes;
export const usePreferences = isLiveData ? live.usePreferences : example.usePreferences;
export const addPreference = isLiveData ? live.addPreference : example.addPreference;
export const removePreference = isLiveData ? live.removePreference : example.removePreference;
export const confirmPreference = isLiveData ? live.confirmPreference : example.confirmPreference;
export const dismissPreference = isLiveData ? live.dismissPreference : example.dismissPreference;
export const stopEnactment = isLiveData ? live.stopEnactment : example.stopEnactment;
export const mergePullRequest = isLiveData ? live.mergePullRequest : example.mergePullRequest;
export const setApprovals = isLiveData ? live.setApprovals : example.setApprovals;
export const setStarred = isLiveData ? live.setStarred : example.setStarred;
export const useStructuralFindings = isLiveData ? live.useStructuralFindings : example.useStructuralFindings;
export const approvePreventionCheck = isLiveData ? live.approvePreventionCheck : example.approvePreventionCheck;
export const useOnboarding = isLiveData ? onboardingLive.useOnboarding : onboardingExample.useOnboarding;
export const addProject = isLiveData ? onboardingLive.addProject : onboardingExample.addProject;
export const saveNeverBreak = isLiveData ? onboardingLive.saveNeverBreak : onboardingExample.saveNeverBreak;
export const approvePreparation = isLiveData ? onboardingLive.approvePreparation : onboardingExample.approvePreparation;
export const mergePreparation = isLiveData ? onboardingLive.mergePreparation : onboardingExample.mergePreparation;
export const refreshPreparation = isLiveData ? onboardingLive.refreshPreparation : onboardingExample.refreshPreparation;
export const inspectAgain = isLiveData ? onboardingLive.inspectAgain : onboardingExample.inspectAgain;
export const checkLiveAgain = isLiveData ? onboardingLive.checkLiveAgain : onboardingExample.checkLiveAgain;
function useExampleApprovalSettings(projectId: string) {
  const project = example.useProject(projectId);
  return {
    loading: project === undefined, active: project?.approvals === "auto", canEnable: true,
    reason: project?.approvals === "auto" ? "Preference saved. You can still choose a fix below." : "You decide which fix goes ahead.",
    scope: undefined as string | undefined,
  };
}
export const useApprovalSettings = isLiveData ? live.useApprovalSettings : useExampleApprovalSettings;
