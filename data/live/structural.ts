import { api } from "../../convex/_generated/api";
import type { StructuralFinding } from "../types";
import { errorMessage, requireLiveClient, useLiveQuery } from "./client";

export function useStructuralFindings(projectId: string): StructuralFinding[] | undefined {
  return useLiveQuery(api.structural.queries.forProject, projectId ? { projectId } : "skip");
}

export async function approvePreventionCheck(findingId: string, passcode?: string): Promise<void> {
  try {
    await requireLiveClient().mutation(api.structural.checks.approve, { findingId, ...(passcode !== undefined && { passcode }) });
  } catch (error) { throw new Error(errorMessage(error)); }
}
