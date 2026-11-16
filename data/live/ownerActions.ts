import type { ApprovalMode } from "../types";
import * as actions from "./actions";
import { withOwnerPasscode } from "./ownerPasscode";

export const approveFix = (caseId: string, fixKey: string) => withOwnerPasscode((passcode) => actions.approveFix(caseId, fixKey, passcode));
export const stopEnactment = (caseId: string) => withOwnerPasscode((passcode) => actions.stopEnactment(caseId, passcode));
export const setApprovals = (projectId: string, mode: ApprovalMode) => withOwnerPasscode((passcode) => actions.setApprovals(projectId, mode, passcode));
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
