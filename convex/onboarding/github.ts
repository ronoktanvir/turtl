import { github, githubToken, type GithubResult } from "../prTracking/github";
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

const rejectedNote = "GITHUB_TOKEN was rejected by GitHub (401), so turtl read without it.";

function unreadable(repo: string, read: Extract<GithubResult<unknown>, { ok: false }>, token: string | undefined, rejected: boolean): string {
  if (read.status === 403 && /rate limit/i.test(read.message)) {
    return `GitHub's limit for reads without a token is used up, so turtl could not read ${repo}. Try again within the hour, or set a valid GITHUB_TOKEN on turtl's deployment.`;
  }
  if (read.status === 404 || read.status === 403) {
    if (token && !rejected) return `GitHub has no repository ${repo} that turtl's GITHUB_TOKEN can read.`;
    return `GitHub shows no public repository ${repo}. If it is private, turtl needs a GITHUB_TOKEN that can read it: ${rejected ? "the one set on turtl's deployment was rejected" : "none is set on turtl's deployment"}.`;
  }
  return `turtl could not read ${repo}: ${read.message}.`;
}

// A request with the token, or without it when GitHub rejects the token, so a public repository stays readable.
async function readWithFallback<T>(path: string, token: string | undefined): Promise<{ read: GithubResult<T>; token: string | undefined; rejected: boolean }> {
  const read = await github<T>(token, path);
  if (!read.ok && read.status === 401 && token) return { read: await github<T>(undefined, path), token: undefined, rejected: true };
  return { read, token, rejected: false };
}

export async function readRaw(repo: string, sha: string, path: string, token: string | undefined): Promise<string | null> {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

// Three GitHub API reads (repository, commit, file tree) and the file contents from raw.githubusercontent.com,
// which does not count against GitHub's API limit.
export async function readRepository(repo: string): Promise<RepoRead> {
  const meta = await readWithFallback<{ default_branch: string }>(`/repos/${repo}`, githubToken());
  if (!meta.read.ok) return { ok: false, reason: unreadable(repo, meta.read, githubToken(), meta.rejected) };
  const { token } = meta;
  const note = meta.rejected ? rejectedNote : undefined;
  const branch = meta.read.body.default_branch;
  const commit = await github<{ sha: string }>(token, `/repos/${repo}/commits/${encodeURIComponent(branch)}`);
  if (!commit.ok) return { ok: false, reason: unreadable(repo, commit, token, meta.rejected) };
  const sha = commit.body.sha;
  const tree = await github<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(token, `/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (!tree.ok) return { ok: false, reason: unreadable(repo, tree, token, meta.rejected) };
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
