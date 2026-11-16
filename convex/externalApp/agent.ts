import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { capyConfig } from "../prTracking/capy";
import { repoFromUrl, type GithubResult } from "../prTracking/github";
import { vAgentMessage, vPullRequestChanges } from "./validators";
import type { ChangedFile } from "./validators";

declare const process: { env: Record<string, string | undefined> };

const MAX_TEXT = 16_000;
const MAX_FILES = 300;
const PATCH_BUDGET = 240_000;

type TranscriptEntry = {
  id: string;
  source: "user" | "assistant" | "tool";
  text: string;
  tool?: string;
  createdAt: string;
};
type TranscriptPage = { items: TranscriptEntry[]; cursor: string | null };
type GithubFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

async function readJson<T>(url: string, headers: Record<string, string>): Promise<GithubResult<T>> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { ok: false, status: response.status, message: `Evidence API answered ${response.status}.` };
    return { ok: true, body: await response.json() as T };
  } catch (error) {
    return { ok: false, message: `Evidence request failed: ${error instanceof Error ? error.name : "unknown error"}.` };
  }
}

export const readGithubJson = <T>(token: string, path: string): Promise<GithubResult<T>> =>
  readJson<T>(`https://api.github.com${path}`, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "turtl",
  });

export function isProtectedPath(path: string, protectedPaths: string[]): boolean {
  const normalized = path.replace(/^\.\//, "");
  return protectedPaths.some((rule) => {
    const escaped = rule.replace(/^\.\//, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    return new RegExp(`^${pattern.replace(/\/$/, "")}(?:/.*)?$`).test(normalized);
  });
}

export async function readChangedFiles(
  token: string,
  repo: string,
  number: number,
  protectedPaths: string[],
): Promise<GithubResult<{ headSha: string; files: ChangedFile[]; truncated: boolean }>> {
  const path = `/repos/${repo}/pulls/${number}`;
  const before = await readGithubJson<{ head: { sha: string } }>(token, path);
  if (!before.ok) return before;
  const headSha = before.body.head?.sha;
  if (!/^[a-f0-9]{40}$/i.test(headSha ?? "")) return { ok: false, message: "GitHub returned no valid PR head SHA." };
  const files: ChangedFile[] = [];
  let budget = PATCH_BUDGET;
  let truncated = false;
  for (let page = 1; page <= MAX_FILES / 100 + 1; page++) {
    const response = await readGithubJson<GithubFile[]>(token, `${path}/files?per_page=100&page=${page}`);
    if (!response.ok) return response;
    if (!Array.isArray(response.body)) return { ok: false, message: "GitHub returned a malformed changed-file list." };
    for (const file of response.body) {
      if (files.length === MAX_FILES) {
        truncated = true;
        break;
      }
      if (typeof file.filename !== "string" || typeof file.status !== "string" ||
          !Number.isFinite(file.additions) || !Number.isFinite(file.deletions)) {
        return { ok: false, message: "GitHub returned malformed changed-file evidence." };
      }
      const patch = typeof file.patch === "string" ? file.patch.slice(0, Math.min(MAX_TEXT, budget)) : undefined;
      budget -= patch?.length ?? 0;
      files.push({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(patch !== undefined && { patch, ...(patch.length < file.patch!.length && { patchTruncated: true }) }),
        protectedPath: isProtectedPath(file.filename, protectedPaths) ||
          (file.previous_filename !== undefined && isProtectedPath(file.previous_filename, protectedPaths)),
      });
    }
    if (truncated || response.body.length < 100) break;
  }
  const after = await readGithubJson<{ head: { sha: string } }>(token, path);
  if (!after.ok) return after;
  if (after.body.head?.sha !== headSha) return { ok: false, message: "The PR head changed while its files were read; no files were attributed to either revision." };
  return { ok: true, body: { headSha, files, truncated } };
}

export const evidenceContext = internalQuery({
  args: { pullRequestId: v.id("pullRequests") },
  handler: async (ctx, { pullRequestId }) => {
    const pull = await ctx.db.get(pullRequestId);
    if (!pull) return null;
    const row = await ctx.db.get(pull.caseId);
    if (!row) return null;
    const externalApp = await ctx.db.query("externalApps").withIndex("by_app", (q) => q.eq("appId", row.appId)).unique();
    if (!externalApp || externalApp.journeyId !== row.journeyId ||
        externalApp.repo.toLowerCase() !== pull.repo.toLowerCase()) return null;
    const action = pull.actionId && await ctx.db.get(pull.actionId);
    const config = action?.executionPayload.config;
    if (!action || action.caseId !== row._id || config?.kind !== "capy" ||
        repoFromUrl(config.repoUrl)?.toLowerCase() !== externalApp.repo.toLowerCase() ||
        config.baseBranch !== externalApp.baseBranch || pull.baseBranch !== externalApp.baseBranch) return null;
    const thread = await ctx.db.query("agentThreads").withIndex("by_pull_request", (q) => q.eq("pullRequestId", pullRequestId)).unique();
    return { pull, externalApp, thread };
  },
});

export const saveTranscript = internalMutation({
  args: {
    pullRequestId: v.id("pullRequests"),
    threadId: v.string(),
    after: v.optional(v.string()),
    cursor: v.optional(v.string()),
    status: v.string(),
    done: v.boolean(),
    messages: v.array(vAgentMessage),
  },
  handler: async (ctx, args) => {
    const pull = await ctx.db.get(args.pullRequestId);
    if (!pull || pull.capyThreadId !== args.threadId) throw new Error("The transcript is not from this PR's coding-agent thread.");
    const existing = await ctx.db.query("agentThreads").withIndex("by_pull_request", (q) => q.eq("pullRequestId", pull._id)).unique();
    if (existing?.cursor !== args.after) return false;
    for (const message of args.messages) {
      if (message.pullRequestId !== pull._id || message.caseId !== pull.caseId || message.threadId !== args.threadId) {
        throw new Error("Agent message provenance does not match the case and PR.");
      }
      const duplicate = await ctx.db.query("agentMessages").withIndex("by_thread_and_message", (q) =>
        q.eq("threadId", args.threadId).eq("messageId", message.messageId)).unique();
      if (duplicate && (duplicate.pullRequestId !== pull._id || duplicate.caseId !== pull.caseId)) {
        throw new Error("This agent transcript is already bound to another case or PR.");
      }
      if (!duplicate) await ctx.db.insert("agentMessages", message);
    }
    const fields = { status: args.status, done: args.done, syncedAt: Date.now(), syncError: undefined,
      ...(args.cursor && { cursor: args.cursor }) };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("agentThreads", { pullRequestId: pull._id, caseId: pull.caseId, threadId: args.threadId, ...fields });
    return true;
  },
});

export const saveChanges = internalMutation({
  args: { row: vPullRequestChanges },
  handler: async (ctx, { row }) => {
    const pull = await ctx.db.get(row.pullRequestId);
    if (!pull || pull.caseId !== row.caseId || pull.repo !== row.repo || pull.number !== row.number) {
      throw new Error("Changed-file evidence does not match the real PR and case.");
    }
    if (pull.snapshot && pull.snapshot.headSha !== row.headSha) return false;
    const existing = await ctx.db.query("pullRequestChanges").withIndex("by_pull_request", (q) => q.eq("pullRequestId", pull._id)).collect();
    if (!existing.some((entry) => entry.headSha === row.headSha)) await ctx.db.insert("pullRequestChanges", row);
    const thread = await ctx.db.query("agentThreads").withIndex("by_pull_request", (q) => q.eq("pullRequestId", pull._id)).unique();
    if (thread) await ctx.db.patch(thread._id, { filesHeadSha: row.headSha });
    return true;
  },
});

export const recordSyncError = internalMutation({
  args: { pullRequestId: v.id("pullRequests"), error: v.string() },
  handler: async (ctx, { pullRequestId, error }) => {
    const pull = await ctx.db.get(pullRequestId);
    if (!pull?.capyThreadId) return;
    const thread = await ctx.db.query("agentThreads").withIndex("by_pull_request", (q) => q.eq("pullRequestId", pullRequestId)).unique();
    const fields = { syncError: error, syncedAt: Date.now(), done: false };
    if (thread) await ctx.db.patch(thread._id, fields);
    else await ctx.db.insert("agentThreads", { pullRequestId, caseId: pull.caseId, threadId: pull.capyThreadId, ...fields });
  },
});

export async function syncAgentEvidence(ctx: ActionCtx, pullRequestId: Id<"pullRequests">): Promise<void> {
  const context: { pull: Doc<"pullRequests">; externalApp: Doc<"externalApps">; thread: Doc<"agentThreads"> | null } | null =
    await ctx.runQuery(internal.externalApp.agent.evidenceContext, { pullRequestId });
  if (!context) return;
  const { pull, externalApp, thread } = context;
  const errors: string[] = [];
  const capy = capyConfig();
  if (pull.capyThreadId && !thread?.done) {
    if (!capy.ok) errors.push("Agent updates unavailable: CAPY_API_KEY is not configured.");
    else {
      const path = `https://api.capy.ai/api/v1/threads/${encodeURIComponent(pull.capyThreadId)}`;
      const headers = { Authorization: `Bearer ${capy.apiKey}` };
      const state = await readJson<{ status: string }>(path, headers);
      if (!state.ok || typeof state.body.status !== "string") errors.push(state.ok ? "Malformed agent thread status." : state.message);
      else {
        let cursor = thread?.cursor;
        for (let page = 0; page < 10; page++) {
          const response = await readJson<TranscriptPage>(`${path}/messages?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, headers);
          if (!response.ok) { errors.push(response.message); break; }
          const { items, cursor: next } = response.body;
          if (!Array.isArray(items) || (next !== null && typeof next !== "string") || items.some((item) =>
            typeof item.id !== "string" || !["user", "assistant", "tool"].includes(item.source) ||
            typeof item.text !== "string" || (item.tool !== undefined && typeof item.tool !== "string") || !Number.isFinite(Date.parse(item.createdAt)))) {
            errors.push("Malformed agent transcript; no synthetic messages were substituted.");
            break;
          }
          const caughtUp = next === null;
          const saved: boolean = await ctx.runMutation(internal.externalApp.agent.saveTranscript, {
            pullRequestId, threadId: pull.capyThreadId, ...(cursor && { after: cursor }),
            ...(next && { cursor: next }),
            status: state.body.status,
            done: caughtUp && ["idle", "failed", "archived"].includes(state.body.status) &&
              (pull.snapshot?.state === "closed" || pull.snapshot?.state === "merged"),
            messages: items.map((item) => ({ caseId: pull.caseId, pullRequestId, threadId: pull.capyThreadId!,
              messageId: item.id, source: item.source, ...(item.tool && { tool: item.tool }),
              text: item.text.slice(0, MAX_TEXT), ...(item.text.length > MAX_TEXT && { truncated: true }), createdAt: Date.parse(item.createdAt) })),
          });
          if (!saved || caughtUp || next === cursor || items.length === 0) break;
          cursor = next!;
        }
      }
    }
  }
  if (pull.number !== undefined) {
    const token = process.env[externalApp.githubCredentialRef];
    if (!token) errors.push(`Changed files unavailable: ${externalApp.githubCredentialRef} is not configured.`);
    else {
      const changes = await readChangedFiles(token, externalApp.repo, pull.number, externalApp.protectedPaths);
      if (!changes.ok) errors.push(changes.message);
      else {
        const saved: boolean = await ctx.runMutation(internal.externalApp.agent.saveChanges, {
          row: { pullRequestId, caseId: pull.caseId, repo: pull.repo, number: pull.number, ...changes.body, readAt: Date.now() },
        });
        if (!saved) errors.push("The tracked PR head changed; refresh GitHub's PR snapshot before attributing its files.");
      }
    }
  }
  if (errors.length) await ctx.runMutation(internal.externalApp.agent.recordSyncError, { pullRequestId, error: errors.join(" ") });
}
