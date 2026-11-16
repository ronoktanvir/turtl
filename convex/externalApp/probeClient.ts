import type { ExternalApp, Fixture } from "./validators";

declare const process: { env: Record<string, string | undefined> };

export type ReadResult<T> = { ok: true; body: T } | { ok: false; message: string };
export type RunningRevision = { revision: string; environment: string };
export type Diagnostics = RunningRevision & {
  fixture: Fixture;
  requestDeadlineMs: number;
  window: { since: number; until: number; truncated: boolean };
  counts: { requests: number; failedRequests: number };
  events: {
    at: number; level: "info" | "warn" | "error"; route: string; message: string;
    status?: number; durationMs?: number; code?: string;
    phases?: { name: string; durationMs: number; rows?: number }[];
  }[];
};

const TIMEOUT_MS = 10_000;
const SHA = /^[a-f0-9]{40}$/;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4000;
const row = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function credential(ref: string): string | undefined {
  return /^[A-Z][A-Z0-9_]*$/.test(ref) ? process.env[ref] || undefined : undefined;
}

export async function readBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("Response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maximum) throw new Error("Response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function endpoint(config: ExternalApp, path: string): string {
  const base = new URL(config.deploymentUrl);
  if (base.username || base.password || base.search || base.hash) throw new Error("Invalid deployment URL");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("Deployment requires HTTPS");
  if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error("Invalid endpoint path");
  return `${config.deploymentUrl.replace(/\/$/, "")}${path}`;
}

async function appJson(config: ExternalApp, path: string, token?: string): Promise<unknown> {
  const response = await fetch(endpoint(config, path), {
    headers: { "Cache-Control": "no-cache", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(response, 128 * 1024)));
}

export async function readRevision(config: ExternalApp): Promise<ReadResult<RunningRevision>> {
  try {
    const body = await appJson(config, config.revisionPath);
    if (!row(body) || typeof body.revision !== "string" || !SHA.test(body.revision) || body.environment !== config.environment) throw new Error("Invalid revision");
    return { ok: true, body: { revision: body.revision, environment: body.environment as string } };
  } catch {
    return { ok: false, message: "The deployed revision is unavailable or malformed." };
  }
}

export async function readDiagnostics(config: ExternalApp): Promise<ReadResult<Diagnostics>> {
  if (!config.diagnostics) return { ok: false, message: "Diagnostics are not configured." };
  const token = credential(config.diagnostics.credentialRef);
  if (!token) return { ok: false, message: "Diagnostics credential is unavailable." };
  try {
    const body = await appJson(config, config.diagnostics.path, token);
    if (!row(body) || typeof body.revision !== "string" || !SHA.test(body.revision) || body.environment !== config.environment || !row(body.fixture) || !text(body.fixture.id) || !count(body.fixture.scoreCount) || !count(body.requestDeadlineMs) || body.requestDeadlineMs === 0 || !row(body.window) || !count(body.window.since) || !count(body.window.until) || body.window.until < body.window.since || body.window.until - body.window.since > 15 * 60_000 || typeof body.window.truncated !== "boolean" || !row(body.counts) || !count(body.counts.requests) || !count(body.counts.failedRequests) || body.counts.failedRequests > body.counts.requests || !Array.isArray(body.events) || body.events.length > 100) throw new Error("Invalid diagnostics");
    const events: Diagnostics["events"] = [];
    for (const event of body.events) {
      if (!row(event) || !count(event.at) || event.at < body.window.since || event.at > body.window.until || !["info", "warn", "error"].includes(String(event.level)) || !text(event.route) || !/^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9/_-]+$/.test(event.route) || !text(event.message)) throw new Error("Invalid event");
      if (events.length && events.at(-1)!.at < event.at) throw new Error("Events not newest first");
      if ((event.status !== undefined && (!count(event.status) || event.status < 100 || event.status > 599)) || (event.durationMs !== undefined && !finite(event.durationMs)) || (event.code !== undefined && !text(event.code))) throw new Error("Invalid event details");
      const phases: NonNullable<Diagnostics["events"][number]["phases"]> = [];
      if (event.phases !== undefined) {
        if (!Array.isArray(event.phases) || event.phases.length > 30) throw new Error("Invalid phases");
        for (const phase of event.phases) {
          if (!row(phase) || !text(phase.name) || !finite(phase.durationMs) || (phase.rows !== undefined && !count(phase.rows))) throw new Error("Invalid phase");
          phases.push({ name: phase.name, durationMs: phase.durationMs, ...(phase.rows !== undefined ? { rows: phase.rows as number } : {}) });
        }
      }
      events.push({
        at: event.at, level: event.level as "info" | "warn" | "error", route: event.route, message: event.message,
        ...(event.status !== undefined ? { status: event.status as number } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs as number } : {}),
        ...(event.code !== undefined ? { code: event.code as string } : {}),
        ...(event.phases !== undefined ? { phases } : {}),
      });
    }
    return { ok: true, body: {
      revision: body.revision, environment: body.environment as string,
      fixture: { id: body.fixture.id, scoreCount: body.fixture.scoreCount }, requestDeadlineMs: body.requestDeadlineMs,
      window: { since: body.window.since, until: body.window.until, truncated: body.window.truncated },
      counts: { requests: body.counts.requests, failedRequests: body.counts.failedRequests }, events,
    } };
  } catch {
    return { ok: false, message: "Diagnostics are unavailable or malformed." };
  }
}

function githubPath(config: ExternalApp): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repo)) throw new Error("Invalid repository");
  return `/repos/${config.repo}`;
}

async function github(config: ExternalApp, path: string, body?: unknown): Promise<Response> {
  const token = credential(config.githubCredentialRef);
  if (!token) throw new Error("GitHub credential is unavailable");
  return fetch(`https://api.github.com${githubPath(config)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "turtl", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function githubJson(config: ExternalApp, path: string): Promise<Record<string, unknown>> {
  const response = await github(config, path);
  const body: unknown = JSON.parse(new TextDecoder().decode(await readBytes(response, 2 * 1024 * 1024)));
  if (!row(body)) throw new Error("Malformed GitHub response");
  return body;
}

export async function dispatchWorkflow(config: ExternalApp, probeId: string): Promise<void> {
  const response = await github(config, `/actions/workflows/${encodeURIComponent(config.probe.workflow)}/dispatches`, {
    ref: config.probe.ref || config.baseBranch, inputs: { probe_id: probeId, target_url: config.deploymentUrl },
  });
  if (response.status !== 204) throw new Error(`GitHub dispatch answered ${response.status}`);
}

export type WorkflowRun = { id: number; html_url: string; head_sha: string; status: string; run_attempt: number };

export async function findWorkflowRun(config: ExternalApp, probeId: string, requestedAt: number): Promise<WorkflowRun | null> {
  const query = new URLSearchParams({ event: "workflow_dispatch", created: `>=${new Date(requestedAt - 60_000).toISOString()}`, per_page: "100" });
  const body = await githubJson(config, `/actions/workflows/${encodeURIComponent(config.probe.workflow)}/runs?${query}`);
  if (!Array.isArray(body.workflow_runs) || Number(body.total_count) > 100) throw new Error("Workflow run list unavailable or truncated");
  const matches = body.workflow_runs.filter((run) => row(run) && run.display_title === `turtl-probe ${probeId}`);
  if (matches.length > 1) throw new Error("More than one workflow run used the probe ID");
  if (!matches.length) return null;
  const run = matches[0];
  if (!row(run) || !count(run.id) || !text(run.html_url) || !run.html_url.startsWith(`https://github.com/${config.repo}/actions/runs/`) || typeof run.head_sha !== "string" || !SHA.test(run.head_sha) || !text(run.status) || run.run_attempt !== 1) throw new Error("Malformed or repeated workflow run");
  return { id: run.id, html_url: run.html_url, head_sha: run.head_sha, status: run.status, run_attempt: 1 };
}

export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

export async function downloadArtifact(config: ExternalApp, runId: number, probeId: string): Promise<Uint8Array> {
  const body = await githubJson(config, `/actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(body.artifacts) || Number(body.total_count) > 100) throw new Error("Artifact list unavailable or truncated");
  const matches = body.artifacts.filter((artifact) => row(artifact) && artifact.name === `turtl-probe-${probeId}`);
  if (matches.length !== 1) throw new Error("The probe artifact is missing or ambiguous");
  const artifact = matches[0];
  if (!row(artifact) || !count(artifact.id) || artifact.expired !== false || !count(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_ARCHIVE_BYTES) throw new Error("The probe artifact is expired or too large");
  let response = await github(config, `/actions/artifacts/${artifact.id}/zip`);
  if (response.status === 302) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Artifact redirect is missing");
    const target = new URL(location);
    if (target.protocol !== "https:" || target.username || target.password || !(target.hostname.endsWith(".blob.core.windows.net") || target.hostname.endsWith(".actions.githubusercontent.com") || target.hostname === "pipelines.actions.githubusercontent.com")) throw new Error("Unexpected artifact host");
    response = await fetch(target.href, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  return readBytes(response, MAX_ARCHIVE_BYTES);
}
