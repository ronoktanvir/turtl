import { githubApiUrl, githubWebUrl } from "./config";
import {
  collaboratorPermissionOf,
  installationAccountId,
  installationOf,
  personRepositoriesOf,
  record,
  repositoriesOf,
  userOf,
  type GithubUser,
  type Installation,
  type PersonRepository,
  type Repository,
} from "./shapes";

const REQUEST_TIMEOUT_MS = 10_000;
export const REPOSITORIES_PER_PAGE = 100;

export type GithubReply<T> = { ok: true; body: T } | { ok: false; status?: number; message: string };

const UNREADABLE = { ok: false, message: "GitHub's answer could not be read." } as const;

type Request = { method?: "GET" | "POST" | "DELETE"; body?: unknown; authorization?: string };

async function github(credential: string, path: string, { method = "GET", body, authorization = `Bearer ${credential}` }: Request = {}): Promise<GithubReply<unknown>> {
  try {
    const response = await fetch(`${githubApiUrl()}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "turtl",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = record(answer)?.message;
      return {
        ok: false,
        status: response.status,
        message: `GitHub answered ${response.status}${typeof message === "string" ? `: ${message}` : ""}`,
      };
    }
    return { ok: true, body: answer };
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
  const minted = await github(jwt, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
  if (!minted.ok) return minted;
  const body = record(minted.body);
  const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  return typeof body?.token === "string" && body.token && Number.isFinite(expiresAt)
    ? { ok: true, body: { token: body.token, expiresAt } }
    : UNREADABLE;
}

// As the app: uninstalls it from the account the installation is on. GitHub then refuses every token of it.
export async function deleteInstallation(jwt: string, installationId: number): Promise<GithubReply<null>> {
  const deleted = await github(jwt, `/app/installations/${installationId}`, { method: "DELETE" });
  return deleted.ok ? { ok: true, body: null } : deleted;
}

// As an installation (its token): one page of the repositories it covers.
export async function listRepositories(token: string, page: number): Promise<GithubReply<Repository[]>> {
  const listed = await github(token, `/installation/repositories?per_page=${REPOSITORIES_PER_PAGE}&page=${page}`);
  if (!listed.ok) return listed;
  const repositories = repositoriesOf(record(listed.body)?.repositories);
  return repositories ? { ok: true, body: repositories } : UNREADABLE;
}

// The person's authorization of the app (GitHub's web application flow), exchanged for a user access token. The
// answer is JSON on 200 even when GitHub refuses the code, with an "error" field instead of a token.
export async function exchangeCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string }): Promise<GithubReply<string>> {
  try {
    const response = await fetch(`${githubWebUrl()}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "turtl" },
      body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = record(await response.json().catch(() => null));
    if (response.ok && typeof body?.access_token === "string" && body.access_token) return { ok: true, body: body.access_token };
    const reason = typeof body?.error === "string" ? body.error : `answered ${response.status}`;
    return { ok: false, status: response.status, message: `GitHub did not accept the authorization (${reason}).` };
  } catch (error) {
    return { ok: false, message: `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}` };
  }
}

// As the person (their user access token): who they are, the installations of this app they can reach, and the
// repositories they can reach in one of them.
export async function readUser(token: string): Promise<GithubReply<GithubUser>> {
  const read = await github(token, "/user");
  if (!read.ok) return read;
  const user = userOf(read.body);
  return user ? { ok: true, body: user } : UNREADABLE;
}

export type UserInstallation = Installation & { suspended: boolean; accountId: number | null };

export async function listUserInstallations(token: string, page: number): Promise<GithubReply<UserInstallation[]>> {
  const listed = await github(token, `/user/installations?per_page=${REPOSITORIES_PER_PAGE}&page=${page}`);
  if (!listed.ok) return listed;
  const items = record(listed.body)?.installations;
  if (!Array.isArray(items)) return UNREADABLE;
  const installations: UserInstallation[] = [];
  for (const item of items) {
    const installation = installationOf(item);
    if (!installation) return UNREADABLE;
    installations.push({ ...installation, accountId: installationAccountId(item) });
  }
  return { ok: true, body: installations };
}

// GitHub lists every repository the person can reach, reading included, with their permissions in each.
export async function listUserRepositories(token: string, installationId: number, page: number): Promise<GithubReply<PersonRepository[]>> {
  const listed = await github(token, `/user/installations/${installationId}/repositories?per_page=${REPOSITORIES_PER_PAGE}&page=${page}`);
  if (!listed.ok) return listed;
  const repositories = personRepositoriesOf(record(listed.body)?.repositories);
  return repositories ? { ok: true, body: repositories } : UNREADABLE;
}

// As an installation (its token): who a GitHub user is now, by the id that never changes (GET /user/{account_id},
// no permission needed), and what they may do in one repository the installation covers (Metadata: read).
export async function readUserById(token: string, userId: number): Promise<GithubReply<GithubUser>> {
  const read = await github(token, `/user/${userId}`);
  if (!read.ok) return read;
  const user = userOf(read.body);
  return user ? { ok: true, body: user } : UNREADABLE;
}

export async function readCollaboratorPermission(token: string, repo: string, login: string): Promise<GithubReply<{ canPush: boolean; userId: number | null }>> {
  const read = await github(token, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
  if (!read.ok) return read;
  const permission = collaboratorPermissionOf(read.body);
  return permission ? { ok: true, body: permission } : UNREADABLE;
}

// Revokes one user access token, with the app's client id and secret as Basic credentials. turtl never keeps the
// token, and revoking it means nobody else can use it either. The person's authorization of the app stays.
export async function revokeUserToken(input: { clientId: string; clientSecret: string; token: string }): Promise<GithubReply<null>> {
  const revoked = await github("", `/applications/${encodeURIComponent(input.clientId)}/token`, {
    method: "DELETE",
    authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
    body: { access_token: input.token },
  });
  return revoked.ok ? { ok: true, body: null } : revoked;
}
