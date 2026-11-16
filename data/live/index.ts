import { useEffect, useState } from "react";
import { useCase } from "./case";

export { useCase } from "./case";
export { useProjects, useProject, useCases, useApprovalSettings } from "./projects";
export { useChat, useCodeNetwork } from "./network";
export { approveFix, declineFixes, stopEnactment, mergePullRequest, setApprovals, addPreference, removePreference, confirmPreference, dismissPreference } from "./ownerActions";
export { usePreferences } from "./preferences";
export { setStarred } from "./actions";

export function useEnactmentNow(caseId: string): number {
  const item = useCase(caseId);
  const running = item?.enactment?.state === "running" || item?.enactment?.state === "merged";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [caseId, running]);
  return now;
}
