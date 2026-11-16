import type { Gate } from "../consent/gate";

declare const process: { env: Record<string, string | undefined> };

// Every request asks the project's gate first (convex/consent/gate.ts): in accounts mode nothing reaches Capy without
// the owner's permission, and starting a thread also counts against the account's daily limit.

const API_URL = "https://api.capy.ai/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const STOPPED_STATUSES = ["idle", "failed", "archived"];
const MAX_PAGES = 20;

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

// The coding agent's full instructions for one approved code change (TUR-68). pullRequestOption stores this
// text as the option's "change" parameter when turtl proposes the fix, the Approve sheet shows that stored
// text, and runCodeChange sends the frozen copy of it word for word: one source, never rendered twice.
const openingFor = (repo: string, baseBranch: string, title: string) =>
  `Make this change in ${repo}, on a new branch from ${baseBranch}. The owner approved it in turtl as "${title}".`;

export function codeChangeInstructions(fix: { repo: string; baseBranch: string; title: string; change: string }): string {
  return [
    openingFor(fix.repo, fix.baseBranch, fix.title),
    fix.change.trim(),
    `Open one pull request against ${fix.baseBranch} titled "${fix.title}" with only this change, and reply with the pull request's URL. Do not merge it: the owner merges it from turtl once its checks pass.`,
  ].join("\n\n");
}

type Value = string | number | boolean | null;

// The text a code-change option sends. Options proposed before TUR-68 stored only the change itself; for those the
// same frame is added here, from the same stored values, so what the owner reads and what is sent still match.
export function instructionsToSend(
  parameters: { name: string; value: Value }[],
  target: { resourceRef: string },
): string | null {
  const read = (name: string) => {
    const value = parameters.find((p) => p.name === name)?.value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const title = read("title");
  const change = read("change");
  if (!title || !change) return null;
  const at = target.resourceRef.lastIndexOf("@");
  const repo = at > 0 ? target.resourceRef.slice(0, at) : target.resourceRef;
  const baseBranch = at > 0 ? target.resourceRef.slice(at + 1) : "main";
  if (change.startsWith(openingFor(repo, baseBranch, title))) return change;
  return codeChangeInstructions({ repo, baseBranch, title, change });
}

type CapyResult<T> = { ok: true; body: T } | { ok: false; message: string };

async function capy<T>(send: typeof fetch, apiKey: string, path: string, body?: unknown): Promise<CapyResult<T>> {
  try {
    const response = await send(`${API_URL}${path}`, {
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
  gate: Gate,
  config: Extract<CapyConfig, { ok: true }>,
  thread: { repo: string; requestId: string; title: string; message: string },
): Promise<CapyResult<{ threadId: string }>> {
  const opened = await gate.open("capy", "start_thread");
  if (!opened.ok) return { ok: false, message: `${opened.reason}.` };
  let projectId = config.projectId;
  if (!projectId) {
    const projects = await capy<{ items: { id: string; repos: { repoFullName: string }[] }[] }>(opened.fetch, config.apiKey, "/projects");
    if (!projects.ok) return projects;
    projectId = projects.body.items.find((project) =>
      project.repos.some((repo) => repo.repoFullName.toLowerCase() === thread.repo.toLowerCase()),
    )?.id;
    if (!projectId) return { ok: false, message: `No Capy project this key can reach holds ${thread.repo}; set CAPY_PROJECT_ID.` };
  }
  const created = await capy<{ id: string }>(opened.fetch, config.apiKey, "/threads", {
    requestId: thread.requestId,
    projectId,
    title: thread.title,
    message: thread.message,
    ...(config.model && { model: config.model }),
  });
  if (!created.ok) return created;
  await gate.threadStarted(thread.requestId);
  return { ok: true, body: { threadId: created.body.id } };
}

// Reads the thread's transcript from `after` on and returns the newest pull request link in `repo` that
// an assistant reply holds, with the cursor to read on from next time.
export async function findPullRequestNumber(
  gate: Gate,
  config: Extract<CapyConfig, { ok: true }>,
  threadId: string,
  repo: string,
  after?: string,
): Promise<CapyResult<{ number?: number; stopped: boolean; status: string; cursor?: string }>> {
  const opened = await gate.open("capy");
  if (!opened.ok) return { ok: false, message: `turtl stopped checking on Capy: ${opened.reason}.` };
  const id = encodeURIComponent(threadId);
  const thread = await capy<{ status: string }>(opened.fetch, config.apiKey, `/threads/${id}`);
  if (!thread.ok) return thread;
  const link = new RegExp("https://github\\.com/" + repo.replace(/\./g, "\\.") + "/pull/(\\d+)", "i");
  let cursor = after;
  let number: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const messages = await capy<{ items: { source: string; text: string }[]; cursor?: string | null }>(
      opened.fetch,
      config.apiKey,
      `/threads/${id}/messages${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (!messages.ok) return messages;
    for (const item of messages.body.items) {
      const match = item.source === "assistant" ? link.exec(item.text) : null;
      if (match) number = Number(match[1]);
    }
    const next = messages.body.cursor ?? undefined;
    if (!next || next === cursor || messages.body.items.length === 0) break;
    cursor = next;
  }
  return {
    ok: true,
    body: {
      ...(number !== undefined && { number }),
      stopped: STOPPED_STATUSES.includes(thread.body.status),
      status: thread.body.status,
      ...(cursor && { cursor }),
    },
  };
}
