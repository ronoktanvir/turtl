import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient, useLiveQuery } from "../live/client";
import { withOwnerPasscode } from "../live/ownerPasscode";
import type { CustomerReports } from "./types";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new Error(errorMessage(error)); }
}

export function useCustomerReports(caseId: string): CustomerReports | null | undefined {
  return useLiveQuery(api.intake.records.forCase, caseId ? { caseId } : "skip");
}

// Deletes one report on one case. In the single-owner demo the owner passcode is asked for, as for every owner decision.
export function deleteCustomerReport(caseId: string, reportId: string): Promise<{ reportCount: number; people: number }> {
  return readable(() =>
    withOwnerPasscode((passcode) =>
      readable(() => requireLiveClient().mutation(api.intake.records.deleteReport, { caseId, reportId, ...(passcode !== undefined && { passcode }) })),
    ),
  );
}
