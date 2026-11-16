import { v } from "convex/values";
import type { Infer } from "convex/values";
import { vActor } from "../constants";

export const vPullRequestState = v.union(v.literal("open"), v.literal("merged"), v.literal("closed"));
export const vChecks = v.union(
  v.literal("none"),
  v.literal("pending"),
  v.literal("passing"),
  v.literal("failing"),
);
export const vCheckRun = v.object({
  name: v.string(),
  status: v.union(v.literal("pending"), v.literal("passed"), v.literal("failed")),
  url: v.optional(v.string()),
});

// GitHub's view of a pull request at its last read.
export const vGithubSnapshot = v.object({
  title: v.string(),
  url: v.string(),
  headSha: v.string(),
  state: vPullRequestState,
  checks: vChecks,
  checkRuns: v.array(vCheckRun),
  mergeable: v.boolean(),
  mergeableState: v.string(),
});

// One pull request for a case. A Capy-opened one has no number until Capy replies with its link.
export const vPullRequestRow = v.object({
  caseId: v.id("cases"),
  source: v.union(v.literal("capy"), v.literal("attached")),
  repo: v.string(),
  baseBranch: v.optional(v.string()),
  number: v.optional(v.number()),
  snapshot: v.optional(vGithubSnapshot),
  actionId: v.optional(v.id("actions")),
  proposalId: v.optional(v.id("proposals")),
  fixKey: v.optional(v.string()),
  stepAttemptId: v.optional(v.id("stepAttempts")),
  capyThreadId: v.optional(v.string()),
  capyCursor: v.optional(v.string()),
  requestedAt: v.number(),
  syncedAt: v.optional(v.number()),
  // When the cron next reads it (convex/prTracking/follow.ts). Missing on a row from before it was kept: due now.
  nextSyncAt: v.optional(v.number()),
  syncError: v.optional(v.string()),
  openError: v.optional(v.string()),
  mergeRequestedBy: v.optional(vActor),
  mergeRequestedAt: v.optional(v.number()),
  mergedAt: v.optional(v.number()),
  mergedBy: v.optional(vActor),
  mergeCommitSha: v.optional(v.string()),
  settledAt: v.optional(v.number()),
});

export type GithubSnapshot = Infer<typeof vGithubSnapshot>;
export type CheckRun = Infer<typeof vCheckRun>;
export type Checks = Infer<typeof vChecks>;

// The UI contract's PullRequest (section 6), field for field.
export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  state: "open" | "merged" | "closed";
  checks: Checks;
  checkRuns: CheckRun[];
  mergeable: boolean;
};

export const pullRequestOf = (repo: string, number: number, snapshot: GithubSnapshot): PullRequest => ({
  repo,
  number,
  title: snapshot.title,
  url: snapshot.url,
  headSha: snapshot.headSha,
  state: snapshot.state,
  checks: snapshot.checks,
  checkRuns: snapshot.checkRuns,
  mergeable: snapshot.mergeable,
});
