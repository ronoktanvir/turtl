import type { Workflow, WorkflowStatus } from "../workflow";

type RecordedStep = {
  _id: string;
  key: string;
  title: string;
  purpose: string;
  dependsOn: string[];
  status: WorkflowStatus;
  skipReason?: string;
  currentAttempt: {
    _id: string;
    attempt: number;
    status: string;
    startedAt?: number;
    finishedAt?: number;
    summary?: string;
    error?: string;
    inputRefs?: string[];
    outputRefs?: { kind: string; id: string; label?: string }[];
  } | null;
};

export function mapWorkflow(record: { _id: string; steps: RecordedStep[] } | null | undefined): Workflow | null | undefined {
  if (record === null || record === undefined) return record;
  return {
    caseId: record._id,
    steps: record.steps.map((step) => ({
      id: step._id,
      key: step.key,
      title: step.title,
      purpose: step.purpose,
      dependsOn: [...step.dependsOn],
      status: step.status,
      skipReason: step.skipReason,
      currentAttempt: step.currentAttempt ? {
        id: step.currentAttempt._id,
        attempt: step.currentAttempt.attempt,
        status: step.currentAttempt.status,
        startedAt: step.currentAttempt.startedAt,
        finishedAt: step.currentAttempt.finishedAt,
        summary: step.currentAttempt.summary,
        error: step.currentAttempt.error,
        inputRefs: [...(step.currentAttempt.inputRefs ?? [])],
        outputRefs: (step.currentAttempt.outputRefs ?? []).map(({ kind, id, label }) => ({ kind, id, label })),
      } : null,
    })),
  };
}
