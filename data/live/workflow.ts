import { api } from "../../convex/_generated/api";
import type { Workflow } from "../workflow";
import { useLiveQuery } from "./client";
import { mapWorkflow } from "./workflowMapping";

export function useWorkflow(caseId: string): Workflow | null | undefined {
  const record = useLiveQuery(api.cases.get, caseId ? { id: caseId } : "skip");
  return caseId ? mapWorkflow(record) : null;
}
