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

// Owners never read raw ids. An id with no recorded name becomes plain words: "collect_app_state" → "collect app state".
export function plainWords(id: string): string {
  return id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

// Replaces each recorded step id (its key or purpose) inside a sentence with the step's name, in quotes.
export function nameSteps(text: string, steps: { key: string; purpose?: string; title: string }[]): string {
  const names = new Map<string, string>();
  for (const step of steps) {
    for (const id of [step.key, step.purpose]) if (id && /[_-]/.test(id) && !names.has(id)) names.set(id, step.title);
  }
  if (!names.size) return text;
  const ids = [...names.keys()].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(?<![\\w-])(${ids.join("|")})(?![\\w-])`, "g"), (id) => `“${names.get(id)}”`);
}

// How each recorded status reads to an owner.
export const statusWords: Record<WorkflowStatus, string> = {
  pending: "Not started",
  running: "Working now",
  waiting: "Waiting",
  done: "Done",
  failed: "Stopped",
  skipped: "Skipped",
};

export function layoutWorkflow(steps: WorkflowStep[]): WorkflowLayout {
  const byKey = new Map<string, WorkflowStep[]>();
  for (const step of steps) byKey.set(step.key, [...(byKey.get(step.key) ?? []), step]);
  const issues: string[] = [];
  const edges: WorkflowEdge[] = [];
  for (const matches of byKey.values()) {
    if (matches.length > 1) issues.push(`Two steps are both recorded as “${matches[0].title}”, so turtl can't tell which one the others wait for.`);
  }
  for (const step of steps) {
    for (const dependency of new Set(step.dependsOn)) {
      const matches = byKey.get(dependency);
      if (!matches) issues.push(`“${step.title}” waits for “${plainWords(dependency)}”, a step that was never recorded.`);
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
  if (unresolved.length > 0) issues.push("turtl can't put the remaining steps in order: they wait on each other in a cycle, or on a step it can't find. What each one did is still shown.");
  return { layers, unresolved, edges, issues };
}
