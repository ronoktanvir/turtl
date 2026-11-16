import type { ApprovalMode } from "../types";
import * as actions from "./actions";
import { withOwnerPasscode } from "./ownerPasscode";
import * as structural from "./structural";

export const approveFix = (caseId: string, fixKey: string, note?: string) => withOwnerPasscode((passcode) => actions.approveFix(caseId, fixKey, passcode, note));
export const declineFixes = (caseId: string, note?: string) => withOwnerPasscode((passcode) => actions.declineFixes(caseId, passcode, note));
export const addPreference = (projectId: string, statement: string) => withOwnerPasscode((passcode) => actions.addPreference(projectId, statement, passcode));
export const removePreference = (_projectId: string, preferenceId: string) => withOwnerPasscode((passcode) => actions.removePreference(preferenceId, passcode));
export const confirmPreference = (_projectId: string, suggestionId: string, statement?: string) => withOwnerPasscode((passcode) => actions.confirmPreference(suggestionId, statement, passcode));
export const dismissPreference = (_projectId: string, suggestionId: string) => withOwnerPasscode((passcode) => actions.dismissPreference(suggestionId, passcode));
export const stopEnactment = (caseId: string) => withOwnerPasscode((passcode) => actions.stopEnactment(caseId, passcode));
export const setApprovals = (projectId: string, mode: ApprovalMode) => withOwnerPasscode((passcode) => actions.setApprovals(projectId, mode, passcode));
export const approvePreventionCheck = (findingId: string) => withOwnerPasscode((passcode) => structural.approvePreventionCheck(findingId, passcode));
export const mergePullRequest = async (caseId: string, headSha: string) => {
  try {
    return await withOwnerPasscode(async (passcode) => {
      const result = await actions.mergePullRequest(caseId, headSha, passcode);
      if (!result.ok && result.reason === "That owner passcode is incorrect. Try again.") throw new Error(result.reason);
      return result;
    });
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : "The merge could not be completed." };
  }
};
