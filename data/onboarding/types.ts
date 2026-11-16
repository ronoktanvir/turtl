import type { PullRequest } from "../types";

// The onboarding agent's view of one project: what it found in the repository, what the owner said must
// never break, the preparation pull request, and which checks work on the live app now.

export type ReadinessKey =
  | "error_logs"
  | "health_check"
  | "readiness_check"
  | "journey_checks"
  | "feature_flags"
  | "recovery_hooks"
  | "test_fixtures";
export type ReadinessStatus = "found" | "missing" | "unknown";

export type FileRef = { path: string; line?: number; url: string };

export type ReadinessItem = {
  key: ReadinessKey;
  label: string;
  status: ReadinessStatus;
  note: string; // plain words
  files: FileRef[]; // set when found
};

export type DetectedStack = {
  id: string;
  label: string; // "Expo with a Convex backend"
  supported: boolean; // automatic preparation works for this stack
  evidence: string[];
};

export type NeverBreak = {
  id: string;
  text: string; // in the owner's words, or a suggestion they kept
  suggested: boolean; // turtl suggested it from the code
  why?: string; // why turtl suggested it
  addCheck: boolean; // the preparation adds a check for it
};

export type OnboardingStage =
  | "inspecting"
  | "inspection_failed"
  | "unsupported" // inspected; automatic preparation is not supported for this stack yet
  | "asking" // waiting for the owner's answers about what must never break
  | "ready" // answered; waiting for the owner's approval
  | "nothing_to_add"
  | "opening" // approved; Capy is writing the pull request
  | "opening_failed"
  | "pr_open"
  | "registering" // merged; checking each endpoint on the live app
  | "registered"
  | "closed"; // the pull request closed without merging

export type LiveCheck = {
  kind: "health" | "readiness" | "journey" | "flag" | "recovery_hook";
  name: string;
  url: string;
  state: "works" | "failing" | "no_response";
  detail: string;
  registered: boolean; // registered as a journey or a recovery action
  checkedAt: number;
};

export type Onboarding = {
  projectId: string;
  repo: string; // owner/name
  repoUrl: string;
  liveUrl?: string;
  folders: string[];
  stage: OnboardingStage;
  inspection?: {
    id: string;
    ref?: string; // commit inspected
    stack?: DetectedStack;
    items: ReadinessItem[];
    summary?: string;
    judgedBy?: "model" | "rules";
    fallbackReason?: string; // why no model judged it
    readNote?: string; // e.g. the GitHub token was rejected
    error?: string;
    finishedAt?: number;
  };
  neverBreak: NeverBreak[];
  answered: boolean;
  approvedAt?: number;
  pullRequest?: PullRequest;
  problem?: string; // why the pull request could not be opened, synced or merged
  checks: LiveCheck[];
  checksError?: string;
  checkedAt?: number;
};

export type NewProject = { repoUrl: string; liveUrl?: string; folders?: string[] };
export type NeverBreakAnswer = { id?: string; text: string; suggested?: boolean; why?: string; addCheck: boolean };
