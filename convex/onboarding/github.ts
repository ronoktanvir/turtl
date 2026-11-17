import { githubRawUrl } from "../github/config";
import { github, type GithubResult } from "../prTracking/github";
import { readable, type RepoFile } from "./detect";

const MAX_FILES = 400;
const FETCH_CONCURRENCY = 12;
const RAW_TIMEOUT_MS = 15_000;

export type RepoRead =
  | {
      ok: true;
      repo: string;
      defaultBranch: string;
      sha: string;
      files: RepoFile[];
      truncated: boolean;
      token: string | undefined;
      note?: string;
    }
  | { ok: false; reason: string };

const rejectedNote = "GitHub turned down turtl's access to this repository, so turtl read it the way anyone can read a public one.";

// Plain words for an owner: what turtl could not do, and what they can do about it. No setting names, and GitHub's own
// error text goes to the log, not the screen. connected: the project reaches its repository through Connect GitHub, so
// what went wrong is that connection, never a missing token.
export function unreadable(repo: string, read: Extract<GithubResult<unknown>, { ok: false }>, token: string | undefined, rejected: boolean, connected = false): string {
  if (connected && (rejected || read.status === 401 || read.status === 403 || read.status === 404)) {
    return `turtl reaches ${repo} through your GitHub connection, but GitHub turned that connection down just now. In this project's Settings, under GitHub, check that it is still connected and still includes ${repo}, then read the repository again.`;
  }
  if (read.status === 403 && /rate limit/i.test(read.message)) {
    return `GitHub limits how often turtl may read repositories it has no access to, and that limit is used up for now, so turtl could not read ${repo}. Try again within the hour, or connect the repository to turtl through GitHub (Add project, Connect GitHub), which lifts the limit.`;
  }
  if (read.status === 404 || read.status === 403) {
    if (token && !rejected) return `GitHub did not let turtl read ${repo}. Check that it is one of the repositories you connected to turtl through GitHub, then read it again.`;
    return `GitHub shows no public repository ${repo}. If it is private, connect it to turtl through GitHub (Add project, Connect GitHub) so turtl can read it${rejected ? "; the access turtl had was turned down" : ""}.`;
  }
  console.error(`onboarding: reading ${repo} failed with ${read.status}: ${read.message}`);
  return `GitHub did not answer when turtl tried to read ${repo}. Try again in a few minutes.`;
}

// A request with the token, or without it when GitHub rejects the token, so a public repository stays readable.
async function readWithFallback<T>(path: string, token: string | undefined): Promise<{ read: GithubResult<T>; token: string | undefined; rejected: boolean }> {
  const read = await github<T>(token, path);
  if (!read.ok && read.status === 401 && token) return { read: await github<T>(undefined, path), token: undefined, rejected: true };
  return { read, token, rejected: false };
}

export type Head = { ok: true; sha: string; branch: string } | { ok: false; gone: boolean };

// The latest commit on a branch (one API read). gone: GitHub says there is no such branch, which is not the same as
// GitHub not answering. A token GitHub rejects is retried without it, so a public repository stays readable.
async function branchHead(repo: string, branch: string, token: string | undefined): Promise<Head> {
  const { read } = await readWithFallback<{ sha?: unknown }>(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, token);
  if (!read.ok) return { ok: false, gone: read.status === 404 || read.status === 422 };
  const sha = read.body?.sha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) ? { ok: true, sha, branch } : { ok: false, gone: false };
}

// The latest commit turtl.json is read at when the owner taps Check again: the head of the branch the preparation
// merged into. When that branch is gone (renamed or deleted since), the head of the repository's default branch, so
// Check again does not fail for good. gone: neither could be found; otherwise GitHub did not answer.
export async function headCommit(repo: string, branch: string, token: string | undefined): Promise<Head> {
  const head = await branchHead(repo, branch, token);
  if (head.ok || !head.gone) return head;
  const { read } = await readWithFallback<{ default_branch?: unknown }>(`/repos/${repo}`, token);
  const fallback = read.ok ? read.body?.default_branch : undefined;
  if (typeof fallback !== "string" || !fallback || fallback === branch) return { ok: false, gone: read.ok || read.status === 404 };
  return await branchHead(repo, fallback, token);
}

// A file at a commit. A token GitHub rejects makes raw.githubusercontent.com answer 404, so a failed read with
// a token is retried without it, which still reads a public repository.
export async function readRaw(repo: string, sha: string, path: string, token: string | undefined): Promise<string | null> {
  try {
    const response = await fetch(`${githubRawUrl()}/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    });
    if (response.ok) return await response.text();
    return token ? await readRaw(repo, sha, path, undefined) : null;
  } catch {
    return null;
  }
}

// Three GitHub API reads (repository, commit, file tree) and the file contents from raw.githubusercontent.com,
// which does not count against GitHub's API limit. The credential comes from repositoryAccess (convex/github/access.ts).
export async function readRepository(repo: string, credential: string | undefined, connected = false): Promise<RepoRead> {
  const meta = await readWithFallback<{ default_branch: string }>(`/repos/${repo}`, credential);
  if (!meta.read.ok) return { ok: false, reason: unreadable(repo, meta.read, credential, meta.rejected, connected) };
  const { token } = meta;
  const note = meta.rejected ? rejectedNote : undefined;
  const branch = meta.read.body.default_branch;
  const commit = await github<{ sha: string }>(token, `/repos/${repo}/commits/${encodeURIComponent(branch)}`);
  if (!commit.ok) return { ok: false, reason: unreadable(repo, commit, token, meta.rejected, connected) };
  const sha = commit.body.sha;
  const tree = await github<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(token, `/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (!tree.ok) return { ok: false, reason: unreadable(repo, tree, token, meta.rejected, connected) };
  const entries = tree.body.tree.filter((entry) => entry.type === "blob" && readable(entry.path, entry.size)).slice(0, MAX_FILES);
  const files: RepoFile[] = [];
  for (let start = 0; start < entries.length; start += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      entries.slice(start, start + FETCH_CONCURRENCY).map(async (entry) => {
        const content = await readRaw(repo, sha, entry.path, token);
        return content === null ? null : { path: entry.path, content };
      }),
    );
    files.push(...batch.filter((file): file is RepoFile => file !== null));
  }
  return {
    ok: true,
    repo,
    defaultBranch: branch,
    sha,
    files,
    truncated: tree.body.truncated || entries.length === MAX_FILES,
    token,
    ...(note && { note }),
  };
}
