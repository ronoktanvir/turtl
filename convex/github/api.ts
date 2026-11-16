import { githubApiUrl } from "./config";
import { installationOf, record, repositoriesOf, type Installation, type Repository } from "./shapes";

const REQUEST_TIMEOUT_MS = 10_000;
export const REPOSITORIES_PER_PAGE = 100;

export type GithubReply<T> = { ok: true; body: T } | { ok: false; status?: number; message: string };

const UNREADABLE = { ok: false, message: "GitHub's answer could not be read." } as const;

async function github(credential: string, path: string, method: "GET" | "POST" = "GET"): Promise<GithubReply<unknown>> {
  try {
    const response = await fetch(`${githubApiUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "turtl",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = record(body)?.message;
      return {
        ok: false,
        status: response.status,
        message: `GitHub answered ${response.status}${typeof message === "string" ? `: ${message}` : ""}`,
      };
    }
    return { ok: true, body };
  } catch (error) {
    return { ok: false, message: `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}` };
  }
}

async function readInstallationAt(jwt: string, path: string): Promise<GithubReply<Installation & { suspended: boolean }>> {
  const read = await github(jwt, path);
  if (!read.ok) return read;
  const installation = installationOf(read.body);
  return installation ? { ok: true, body: installation } : UNREADABLE;
}

// As the app (a JWT): one installation by id, or the installation that covers a repository (404 when none does).
export const readInstallation = (jwt: string, installationId: number) => readInstallationAt(jwt, `/app/installations/${installationId}`);
export const readRepositoryInstallation = (jwt: string, repo: string) => readInstallationAt(jwt, `/repos/${repo}/installation`);

export async function readApp(jwt: string): Promise<GithubReply<{ slug: string; permissions: Record<string, unknown>; events: unknown[] }>> {
  const read = await github(jwt, "/app");
  if (!read.ok) return read;
  const app = record(read.body);
  const permissions = record(app?.permissions);
  return typeof app?.slug === "string" && permissions && Array.isArray(app.events)
    ? { ok: true, body: { slug: app.slug, permissions, events: app.events } }
    : UNREADABLE;
}

export async function mintInstallationToken(jwt: string, installationId: number): Promise<GithubReply<{ token: string; expiresAt: number }>> {
  const minted = await github(jwt, `/app/installations/${installationId}/access_tokens`, "POST");
  if (!minted.ok) return minted;
  const body = record(minted.body);
  const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  return typeof body?.token === "string" && body.token && Number.isFinite(expiresAt)
    ? { ok: true, body: { token: body.token, expiresAt } }
    : UNREADABLE;
}

// As an installation (its token): one page of the repositories it covers.
export async function listRepositories(token: string, page: number): Promise<GithubReply<Repository[]>> {
  const listed = await github(token, `/installation/repositories?per_page=${REPOSITORIES_PER_PAGE}&page=${page}`);
  if (!listed.ok) return listed;
  const repositories = repositoriesOf(record(listed.body)?.repositories);
  return repositories ? { ok: true, body: repositories } : UNREADABLE;
}
