import type { CheckRun, Checks, GithubSnapshot } from "./validators";

declare const process: { env: Record<string, string | undefined> };

const API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
const PASSED_CONCLUSIONS = ["success", "neutral", "skipped"];

export type GithubResult<T> = { ok: true; body: T } | { ok: false; status?: number; message: string };

export type GithubPull = {
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  merge_commit_sha: string | null;
  head: { sha: string };
};
export type GithubCheckRun = { name: string; status: string; conclusion: string | null; html_url: string | null };
export type GithubStatus = { context: string; state: string; target_url: string | null };

export const githubToken = () => process.env.GITHUB_TOKEN || undefined;

export function parsePullRequestUrl(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

export function repoFromUrl(repoUrl: string): string | null {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

async function github<T>(token: string, path: string, init?: { method: string; body: unknown }): Promise<GithubResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "turtl",
        ...(init && { "Content-Type": "application/json" }),
      },
      ...(init && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (body as { message?: unknown } | null)?.message;
      return {
        ok: false,
        status: response.status,
        message: `GitHub answered ${response.status}${typeof message === "string" ? `: ${message}` : ""}`,
      };
    }
    return { ok: true, body: body as T };
  } catch (error) {
    return { ok: false, message: `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}` };
  }
}

export function checkRunsOf(runs: GithubCheckRun[], statuses: GithubStatus[]): CheckRun[] {
  return [
    ...runs.map((run): CheckRun => ({
      name: run.name,
      status:
        run.status !== "completed" || !run.conclusion
          ? "pending"
          : PASSED_CONCLUSIONS.includes(run.conclusion)
            ? "passed"
            : "failed",
      ...(run.html_url ? { url: run.html_url } : {}),
    })),
    ...statuses.map((status): CheckRun => ({
      name: status.context,
      status: status.state === "success" ? "passed" : status.state === "pending" ? "pending" : "failed",
      ...(status.target_url ? { url: status.target_url } : {}),
    })),
  ];
}

export function checksOf(checkRuns: CheckRun[]): Checks {
  if (checkRuns.length === 0) return "none";
  if (checkRuns.some((run) => run.status === "failed")) return "failing";
  if (checkRuns.some((run) => run.status === "pending")) return "pending";
  return "passing";
}

export function snapshotOf(pull: GithubPull, runs: GithubCheckRun[], statuses: GithubStatus[]): GithubSnapshot {
  const checkRuns = checkRunsOf(runs, statuses);
  const state = pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open";
  return {
    title: pull.title,
    url: pull.html_url,
    headSha: pull.head.sha,
    state,
    checks: checksOf(checkRuns),
    checkRuns,
    mergeable: state === "open" && !pull.draft && pull.mergeable === true,
    mergeableState: pull.draft ? "draft" : (pull.mergeable_state ?? "unknown"),
  };
}

// Reads the pull request, then the check runs and commit statuses on its head commit.
export async function readPullRequest(
  token: string,
  repo: string,
  number: number,
): Promise<GithubResult<{ snapshot: GithubSnapshot; mergeCommitSha?: string }>> {
  const pull = await github<GithubPull>(token, `/repos/${repo}/pulls/${number}`);
  if (!pull.ok) return pull;
  const sha = pull.body.head.sha;
  const [runs, combined] = await Promise.all([
    github<{ check_runs: GithubCheckRun[] }>(token, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
    github<{ statuses: GithubStatus[] }>(token, `/repos/${repo}/commits/${sha}/status?per_page=100`),
  ]);
  if (!runs.ok) return runs;
  if (!combined.ok) return combined;
  return {
    ok: true,
    body: {
      snapshot: snapshotOf(pull.body, runs.body.check_runs, combined.body.statuses),
      ...(pull.body.merged && pull.body.merge_commit_sha ? { mergeCommitSha: pull.body.merge_commit_sha } : {}),
    },
  };
}

// GitHub merges only while the head is still `sha`, so a push after the owner looked fails the merge.
export const mergePullRequest = (token: string, repo: string, number: number, sha: string) =>
  github<{ merged: boolean; sha: string; message: string }>(token, `/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: { sha },
  });
