export type Health = "affected" | "needs_you" | "working" | "clear";
export type CaseType = "fix" | "feature";
export type CaseStatus =
  | "investigating"
  | "needs_approval"
  | "enacting"
  | "ready_to_merge"
  | "resolved"
  | "unresolved"
  | "declined";
export type FixKind = "recovery" | "repair" | "prevention" | "change";
export type ApprovalMode = "you" | "auto";

export type Project = {
  id: string;
  name: string; // the GitHub repo's name
  iconUrl?: string; // fall back to the name's first letter
  summary?: string; // one line on what the app is
  repoUrl?: string;
  productionUrl?: string;
  health: Health;
  bugCount: number; // open fixes
  featureCount: number; // open features
  needsApprovalCount: number;
  approvals: ApprovalMode;
};

export type CaseSummary = {
  id: string;
  projectId: string;
  type: CaseType;
  number: number; // "error #10", "request #4"
  title: string; // short
  category:
    | "outage"
    | "broken_journey"
    | "bug"
    | "failed_deployment"
    | "feature_request"
    | "feedback"
    | "suggestion";
  status: CaseStatus;
  health: Health;
  happenedAt: number;
  reportCount?: number; // how many people asked or reported
  starred?: boolean;
};

// A span with `cite` is drawn highlighted; tapping it opens that citation in place.
export type Span = { text: string; cite?: string };
export type Citation =
  | { id: string; kind: "log"; logId: string }
  | { id: string; kind: "code"; codeId: string };

export type Visualization =
  | { type: "journey"; steps: { label: string; state: "passed" | "failed" | "not_reached" }[] }
  | { type: "series"; label: string; unit: string; points: { t: number; v: number }[]; markerAt?: number };

export type OverviewBlock =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "visualization"; title: string; viz: Visualization };

export type LogLine = {
  id: string;
  at: number;
  level: "info" | "warn" | "error";
  source: string; // which service or screen wrote it
  text: string;
};

export type CodeRef = {
  id: string;
  path: string;
  startLine: number;
  language: string;
  before: string; // the code as it is now
  after?: string; // the code replacing it, when a fix changes it
  note?: string; // one plain sentence on what this code does
};

export type Screenshot = {
  id: string;
  url: string;
  caption: string;
  phase: "failure" | "before" | "after";
  takenAt: number;
};

export type FixOption = {
  key: string;
  title: string;
  kind: FixKind;
  recommended: boolean; // exactly one option in a list is true
  why: Span[]; // plain words; may cite logs or code
  whatChanges: string;
  whatMightBeLost: string; // shown under "Trade-offs"
  howChecked: string;
  usersCantNow?: string;
  confidence?: number; // 0 to 1
  codeIds?: string[]; // CodeRef ids this fix replaces
  proposedInChat?: boolean;
};

export type PlanStep = {
  key: string;
  title: string;
  detail?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
};

export type PullRequest = {
  repo: string; // owner/name
  number: number;
  title: string;
  url: string;
  headSha: string;
  state: "open" | "merged" | "closed";
  checks: "none" | "pending" | "passing" | "failing";
  checkRuns: { name: string; status: "pending" | "passed" | "failed"; url?: string }[];
  mergeable: boolean;
};

export type Enactment = {
  fixKey: string;
  state: "running" | "stopped" | "needs_you" | "waiting_for_merge" | "merged" | "done" | "failed";
  steps: PlanStep[];
  pullRequest?: PullRequest;
  question?: { text: string; fixes: FixOption[] }; // set when the work stopped on something unexpected
};

export type CaseDetail = CaseSummary & {
  summary: string; // the turtle's one line
  overview: OverviewBlock[];
  citations: Citation[];
  logs: LogLine[];
  code: CodeRef[];
  screenshots: Screenshot[];
  fixes: FixOption[]; // 1 to 4
  enactment?: Enactment;
  learned?: string; // "What turtl learned"
};

export type ChatScope =
  | { kind: "case"; caseId: string }
  | { kind: "project"; projectId: string }
  | { kind: "cluster"; projectId: string; clusterId: string }
  | { kind: "node"; projectId: string; nodeId: string };

export type ChatMessage = {
  id: string;
  role: "owner" | "turtl";
  text: string;
  at: number;
  proposedFix?: FixOption;
};

export type NetCluster = { id: string; name: string; summary: string; health?: Health };
export type NetNode = {
  id: string;
  clusterId: string;
  label: string;
  kind: "screen" | "module" | "service" | "data" | "external";
  path?: string;
  summary: string;
  weight?: number; // relative size, 1 by default
};
export type NetEdge = {
  from: string;
  to: string;
  relation: "imports" | "calls" | "reads" | "writes" | "depends_on";
};
export type CodeNetwork = {
  projectId: string;
  generatedAt: number;
  clusters: NetCluster[];
  nodes: NetNode[];
  edges: NetEdge[];
};
