import { demoOnly, standInOnly } from "../demoSettings";

declare const process: { env: Record<string, string | undefined> };

// Revyl's HTTP API, read from turtl's side. Only Convex actions call it; the key is read from the
// named environment variable and never returned or logged.

export const API_KEY_VAR = "REVYL_API_KEY";
export const BOOKING_WORKFLOW_VAR = "REVYL_BOOKING_WORKFLOW_ID";
const DEFAULT_BASE_URL = "https://backend.revyl.ai";
const REQUEST_TIMEOUT_MS = 20_000;

// The only settings turtl will send to Revyl as its key. A check's `credentialRef` is data stored on a row, so like
// SENDABLE_CREDENTIAL_REFS in convex/protectedApp/client.ts it must never choose which of the deployment's secrets
// leaves: any other name is refused before anything is read or sent.
export const SENDABLE_REVYL_KEY_VARS: readonly string[] = [API_KEY_VAR];

export type RevylConfig = { baseUrl: string; apiKey: string; workflowId: string };

// A check names its workflow and key variable (vCheck kind "revyl"); without one, the booking journey's workflow is
// used. That workflow is the demo's: with accounts on it reads as not set, so no account's verify step runs the demo's
// device check on the operator's Revyl credits.
export function revylConfig(check?: {
  workflowId?: string;
  credentialRef?: string;
}): { ok: true; config: RevylConfig } | { ok: false; missing: string[]; refused?: string } {
  const keyVar = check?.credentialRef ?? API_KEY_VAR;
  if (!SENDABLE_REVYL_KEY_VARS.includes(keyVar)) {
    return { ok: false, missing: [], refused: `turtl does not send the setting named ${keyVar} to Revyl` };
  }
  const apiKey = process.env[keyVar];
  const workflowId = check?.workflowId ?? demoOnly(process.env[BOOKING_WORKFLOW_VAR]);
  if (!apiKey || !workflowId) {
    return { ok: false, missing: [...(apiKey ? [] : [keyVar]), ...(workflowId ? [] : [BOOKING_WORKFLOW_VAR])] };
  }
  // A stand-in address for tests; with accounts on it is honoured only on a local backend, so the key goes to Revyl.
  const baseUrl = (standInOnly(process.env.REVYL_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { ok: true, config: { baseUrl, apiKey, workflowId } };
}

type Answer<T> = { ok: true; body: T } | { ok: false; reason: string };

async function request<T>(config: RevylConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer<T>> {
  const route = `${method} ${path.split("?")[0]}`;
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `Revyl answered HTTP ${response.status} to ${route}` };
    return { ok: true, body: (await response.json()) as T };
  } catch (error) {
    return { ok: false, reason: `${route} to Revyl failed (${error instanceof Error ? error.name : "unknown error"})` };
  }
}

export type WorkflowStatus = {
  status: "queued" | "setup" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  total_tests: number;
  passed_tests?: number;
  failed_tests?: number;
  error_message?: string | null;
  child_tasks?: { id: string; test_id: string; status?: string | null; success?: boolean | null; error_message?: string | null }[];
};

type ReportAction = {
  completed_at?: string | null;
  screenshot_after_url?: string | null;
  screenshot_before_url?: string | null;
};

type ReportStep = {
  execution_order: number;
  step_description?: string | null;
  effective_status?: string;
  error_message?: string | null;
  completed_at?: string | null;
  actions?: ReportAction[];
};

export type ReportContext = {
  test_name?: string | null;
  device_model?: string | null;
  report_url?: string | null;
  error_message?: string | null;
  steps?: ReportStep[] | null;
};

export const TERMINAL_STATUSES: WorkflowStatus["status"][] = ["completed", "failed", "cancelled", "timeout"];

// POST /api/v1/workflow-executions queues every test in the workflow on a cloud device.
export const startWorkflow = (config: RevylConfig) =>
  request<{ task_id: string }>(config, "POST", "/api/v1/workflow-executions", { workflow_id: config.workflowId });

export const workflowStatus = (config: RevylConfig, taskId: string) =>
  request<WorkflowStatus>(config, "GET", `/api/v1/workflows/status/${encodeURIComponent(taskId)}`);

// One test execution's report: its steps, each with the actions the agent took and their screenshots.
export const reportContext = (config: RevylConfig, executionId: string) =>
  request<ReportContext>(
    config,
    "GET",
    `/api/v1/reports-v3/reports/by-execution/${encodeURIComponent(executionId)}/context?include_steps=true&include_actions=true&include_llm_calls=false`,
  );

export const failedStep = (report: ReportContext) =>
  (report.steps ?? []).find((step) => step.effective_status === "failed");

// One screenshot per step: the screen after the last action in that step that has one.
export function stepScreenshots(report: ReportContext) {
  return [...(report.steps ?? [])]
    .sort((a, b) => a.execution_order - b.execution_order)
    .flatMap((step) => {
      const action = [...(step.actions ?? [])]
        .reverse()
        .find((a) => a.screenshot_after_url || a.screenshot_before_url);
      const url = action?.screenshot_after_url || action?.screenshot_before_url;
      if (!action || !url) return [];
      const description = step.step_description || `Step ${step.execution_order}`;
      return [
        {
          url,
          caption: step.effective_status === "failed" ? `Failed: ${description}` : description,
          takenAt: Date.parse(action.completed_at ?? step.completed_at ?? "") || Date.now(),
        },
      ];
    });
}
