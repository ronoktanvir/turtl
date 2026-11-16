export type WorkflowStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export type WorkflowStep = {
  id: string;
  key: string;
  title: string;
  purpose: string;
  dependsOn: string[];
  status: WorkflowStatus;
  skipReason?: string;
  currentAttempt: {
    id: string;
    attempt: number;
    status: string;
    startedAt?: number;
    finishedAt?: number;
    summary?: string;
    error?: string;
    inputRefs: string[];
    outputRefs: { kind: string; id: string; label?: string }[];
  } | null;
};

export type Workflow = { caseId: string; steps: WorkflowStep[] };
export type WorkflowEdge = { from: string; to: string };
export type WorkflowLayout = {
  layers: WorkflowStep[][];
  unresolved: WorkflowStep[];
  edges: WorkflowEdge[];
  issues: string[];
};

export function layoutWorkflow(steps: WorkflowStep[]): WorkflowLayout {
  const byKey = new Map<string, WorkflowStep[]>();
  for (const step of steps) byKey.set(step.key, [...(byKey.get(step.key) ?? []), step]);
  const issues: string[] = [];
  const edges: WorkflowEdge[] = [];
  for (const [key, matches] of byKey) {
    if (matches.length > 1) issues.push(`Duplicate step key: ${key}. Dependencies on it are ambiguous.`);
  }
  for (const step of steps) {
    for (const dependency of new Set(step.dependsOn)) {
      const matches = byKey.get(dependency);
      if (!matches) issues.push(`${step.key}: missing dependency ${dependency}.`);
      if (matches?.length === 1) edges.push({ from: matches[0].id, to: step.id });
    }
  }
  const placed = new Set<string>();
  const layers: WorkflowStep[][] = [];
  while (true) {
    const layer = steps.filter((step) => !placed.has(step.id) && byKey.get(step.key)?.length === 1 && step.dependsOn.every((key) => {
      const matches = byKey.get(key);
      return matches?.length === 1 && placed.has(matches[0].id);
    }));
    if (layer.length === 0) break;
    layers.push(layer);
    for (const step of layer) placed.add(step.id);
  }
  const unresolved = steps.filter((step) => !placed.has(step.id));
  if (unresolved.length > 0) issues.push("Dependency order unavailable for the remaining steps: a cycle, missing dependency, or ambiguous key prevents ordering. Their recorded statuses are unchanged.");
  return { layers, unresolved, edges, issues };
}
