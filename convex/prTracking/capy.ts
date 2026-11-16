declare const process: { env: Record<string, string | undefined> };

const API_URL = "https://api.capy.ai/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const STOPPED_STATUSES = ["idle", "failed", "archived"];

export type CapyConfig =
  | { ok: true; apiKey: string; projectId?: string; model?: { modelId: string; reasoningMode?: string } }
  | { ok: false; missing: string[] };

// CAPY_PROJECT_ID, CAPY_MODEL_ID and CAPY_REASONING are optional: without a project id, the thread goes
// to the project that holds the repository.
export function capyConfig(): CapyConfig {
  const apiKey = process.env.CAPY_API_KEY;
  if (!apiKey) return { ok: false, missing: ["CAPY_API_KEY"] };
  const projectId = process.env.CAPY_PROJECT_ID;
  const modelId = process.env.CAPY_MODEL_ID;
  const reasoningMode = process.env.CAPY_REASONING;
  return {
    ok: true,
    apiKey,
    ...(projectId && { projectId }),
    ...(modelId && { model: { modelId, ...(reasoningMode && { reasoningMode }) } }),
  };
}

type CapyResult<T> = { ok: true; body: T } | { ok: false; message: string };

async function capy<T>(apiKey: string, path: string, body?: unknown): Promise<CapyResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, message: `Capy answered ${response.status}.` };
    return { ok: true, body: (await response.json()) as T };
  } catch (error) {
    return { ok: false, message: `Capy request failed: ${error instanceof Error ? error.name : "unknown error"}.` };
  }
}

// Starts a Capy thread that writes the change and opens the pull request. The same requestId returns
// the same thread, so a retried step never starts a second one.
export async function startCapyThread(
  config: Extract<CapyConfig, { ok: true }>,
  thread: { repo: string; requestId: string; title: string; message: string },
): Promise<CapyResult<{ threadId: string }>> {
  let projectId = config.projectId;
  if (!projectId) {
    const projects = await capy<{ items: { id: string; repos: { repoFullName: string }[] }[] }>(config.apiKey, "/projects");
    if (!projects.ok) return projects;
    projectId = projects.body.items.find((project) =>
      project.repos.some((repo) => repo.repoFullName.toLowerCase() === thread.repo.toLowerCase()),
    )?.id;
    if (!projectId) return { ok: false, message: `No Capy project this key can reach holds ${thread.repo}; set CAPY_PROJECT_ID.` };
  }
  const created = await capy<{ id: string }>(config.apiKey, "/threads", {
    requestId: thread.requestId,
    projectId,
    title: thread.title,
    message: thread.message,
    ...(config.model && { model: config.model }),
  });
  return created.ok ? { ok: true, body: { threadId: created.body.id } } : created;
}

// Looks for the pull request link in the thread's newest assistant reply that names one in `repo`.
export async function findPullRequestNumber(
  config: Extract<CapyConfig, { ok: true }>,
  threadId: string,
  repo: string,
): Promise<CapyResult<{ number?: number; stopped: boolean; status: string }>> {
  const id = encodeURIComponent(threadId);
  const [thread, messages] = await Promise.all([
    capy<{ status: string }>(config.apiKey, `/threads/${id}`),
    capy<{ items: { source: string; text: string; createdAt: string }[] }>(config.apiKey, `/threads/${id}/messages`),
  ]);
  if (!thread.ok) return thread;
  if (!messages.ok) return messages;
  const link = new RegExp("https://github\\.com/" + repo.replace(/\./g, "\\.") + "/pull/(\\d+)", "i");
  const number = messages.body.items
    .filter((item) => item.source === "assistant")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => link.exec(item.text)?.[1])
    .find((match) => match !== undefined);
  return {
    ok: true,
    body: {
      ...(number !== undefined && { number: Number(number) }),
      stopped: STOPPED_STATUSES.includes(thread.body.status),
      status: thread.body.status,
    },
  };
}
