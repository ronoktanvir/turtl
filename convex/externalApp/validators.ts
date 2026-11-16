import { v } from "convex/values";
import type { Infer } from "convex/values";
import { vCriterion } from "../constants";
import { vCheckRun, vChecks } from "../prTracking/validators";

// An external web app turtl is connected to: someone else's repository and deployment, described by
// configuration. Credentials are named here and read from the Convex environment; no value is stored.

export const vViewport = v.object({ width: v.number(), height: v.number() });

// The dataset a probe ran against. Counts are whatever the app reports, kept under the app's own names.
export const vFixture = v.object({ id: v.string(), counts: v.record(v.string(), v.number()) });

export const vExternalApp = v.object({
  appId: v.id("apps"),
  journeyId: v.id("journeys"),
  actionCatalogId: v.id("actionCatalog"),
  repo: v.string(),
  baseBranch: v.string(),
  baselineSha: v.optional(v.string()),
  deploymentUrl: v.string(),
  environment: v.string(),
  revisionPath: v.string(),
  diagnostics: v.optional(v.object({ path: v.string(), credentialRef: v.string() })),
  githubCredentialRef: v.string(),
  probe: v.object({
    workflow: v.string(),
    ref: v.optional(v.string()),
    viewport: vViewport,
    timeoutMinutes: v.number(),
  }),
  criteria: v.array(vCriterion),
  regressionCheck: v.optional(v.string()),
  protectedPaths: v.array(v.string()),
  commands: v.optional(
    v.object({
      setup: v.optional(v.string()),
      fixture: v.optional(v.string()),
      acceptanceTest: v.optional(v.string()),
    }),
  ),
  deployTimeoutMinutes: v.number(),
  isTestDouble: v.optional(v.boolean()),
});

export const vProbeStep = v.object({
  step: v.string(),
  verdict: v.union(v.literal("passed"), v.literal("failed"), v.literal("skipped")),
  detail: v.string(),
  durationMs: v.optional(v.number()),
  request: v.optional(
    v.object({
      method: v.string(),
      path: v.string(),
      status: v.union(v.number(), v.null()),
      outcome: v.union(v.literal("ok"), v.literal("timeout"), v.literal("error")),
      durationMs: v.number(),
    }),
  ),
});

// What the app's probe reported, after turtl checked its shape. turtl decides the outcome, not this verdict alone.
export const vProbeResult = v.object({
  verdict: v.union(v.literal("passed"), v.literal("failed")),
  failedStep: v.union(v.string(), v.null()),
  error: v.union(v.object({ code: v.string(), message: v.string() }), v.null()),
  revision: v.string(),
  environment: v.string(),
  fixture: v.optional(vFixture),
  deadlineMs: v.optional(v.number()),
  viewport: v.optional(vViewport),
  startedAt: v.number(),
  completedAt: v.number(),
  steps: v.array(vProbeStep),
  criteria: v.array(
    v.object({
      id: v.string(),
      status: v.union(v.literal("passed"), v.literal("failed"), v.literal("not_run")),
      detail: v.string(),
    }),
  ),
  cleanup: v.optional(v.object({ ok: v.boolean(), detail: v.string() })),
});

export const vProbePurpose = v.union(v.literal("monitor"), v.literal("reproduce"), v.literal("verify"));
export const vProbeOutcome = v.union(v.literal("passed"), v.literal("failed"), v.literal("inconclusive"));

// One run of the app's gameplay probe in a real browser. It is dispatched, then read back; a run that
// cannot be read is inconclusive, never passed or failed.
export const vProbeRun = v.object({
  externalAppId: v.id("externalApps"),
  appId: v.id("apps"),
  purpose: vProbePurpose,
  probeId: v.string(),
  caseId: v.optional(v.id("cases")),
  stepAttemptId: v.optional(v.id("stepAttempts")),
  requestedAt: v.number(),
  revisionBefore: v.optional(v.string()),
  revisionAfter: v.optional(v.string()),
  expectedRevision: v.optional(v.string()),
  githubRunId: v.optional(v.number()),
  githubRunUrl: v.optional(v.string()),
  probeCodeSha: v.optional(v.string()),
  result: v.optional(vProbeResult),
  outcome: v.optional(vProbeOutcome),
  reason: v.optional(v.string()),
  lastError: v.optional(v.string()),
  completedAt: v.optional(v.number()),
});

// A screenshot taken by the probe's browser. Always browser evidence, never a device test. A capture
// that could not be stored keeps its row with the reason, so the gap is visible.
export const vBrowserScreenshot = v.object({
  appId: v.id("apps"),
  caseId: v.optional(v.id("cases")),
  probeRunId: v.id("probeRuns"),
  storageId: v.optional(v.id("_storage")),
  unavailableReason: v.optional(v.string()),
  file: v.string(),
  step: v.optional(v.string()),
  caption: v.string(),
  phase: v.union(v.literal("failure"), v.literal("before"), v.literal("after")),
  capturedAt: v.number(),
  viewport: vViewport,
  pixelWidth: v.optional(v.number()),
  pixelHeight: v.optional(v.number()),
  commitSha: v.string(),
  environment: v.string(),
  fixture: v.optional(vFixture),
  sourceUrl: v.optional(v.string()),
});

// Where turtl has read a coding agent's thread up to.
export const vAgentThread = v.object({
  pullRequestId: v.id("pullRequests"),
  caseId: v.id("cases"),
  threadId: v.string(),
  cursor: v.optional(v.string()),
  status: v.optional(v.string()),
  filesHeadSha: v.optional(v.string()),
  syncedAt: v.optional(v.number()),
  syncError: v.optional(v.string()),
  done: v.boolean(),
});

// One entry of the coding agent's own transcript, stored as the agent's API returned it. turtl never
// rewrites the text; `truncated` says when a long entry was cut to fit.
export const vAgentMessage = v.object({
  caseId: v.id("cases"),
  pullRequestId: v.id("pullRequests"),
  threadId: v.string(),
  messageId: v.string(),
  source: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")),
  tool: v.optional(v.string()),
  text: v.string(),
  truncated: v.optional(v.boolean()),
  createdAt: v.number(),
});

export const vChangedFile = v.object({
  path: v.string(),
  status: v.string(),
  additions: v.number(),
  deletions: v.number(),
  patch: v.optional(v.string()),
  patchTruncated: v.optional(v.boolean()),
  protectedPath: v.boolean(),
});

// The files a pull request changes at one head commit, as GitHub lists them.
export const vPullRequestChanges = v.object({
  pullRequestId: v.id("pullRequests"),
  caseId: v.id("cases"),
  repo: v.string(),
  number: v.number(),
  headSha: v.string(),
  files: v.array(vChangedFile),
  truncated: v.boolean(),
  readAt: v.number(),
});

// The three facts about a repair, kept apart: the candidate was tested, the merged revision is
// running, and gameplay was verified on that running revision. None implies another.
export const vRepairProof = v.object({
  caseId: v.id("cases"),
  externalAppId: v.id("externalApps"),
  actionId: v.id("actions"),
  pullRequestId: v.id("pullRequests"),
  stepAttemptId: v.optional(v.id("stepAttempts")),
  candidate: v.object({
    status: v.union(v.literal("passed"), v.literal("failed"), v.literal("pending"), v.literal("not_tested")),
    headSha: v.string(),
    checks: vChecks,
    checkRuns: v.array(vCheckRun),
    regressionCheck: v.optional(
      v.object({
        name: v.string(),
        status: v.union(v.literal("passed"), v.literal("failed"), v.literal("pending"), v.literal("missing")),
      }),
    ),
    observedAt: v.number(),
  }),
  deployment: v.object({
    status: v.union(v.literal("waiting"), v.literal("confirmed"), v.literal("not_confirmed")),
    expectedSha: v.string(),
    observedSha: v.optional(v.string()),
    environment: v.string(),
    waitingSince: v.number(),
    lastCheckedAt: v.optional(v.number()),
    confirmedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  }),
  gameplay: v.object({
    status: v.union(
      v.literal("not_run"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("inconclusive"),
    ),
    probeRunId: v.optional(v.id("probeRuns")),
    verificationId: v.optional(v.id("verifications")),
    completedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
  }),
});

export type ExternalApp = Infer<typeof vExternalApp>;
export type Fixture = Infer<typeof vFixture>;
export type ProbeResult = Infer<typeof vProbeResult>;
export type ProbeStep = Infer<typeof vProbeStep>;
export type ProbeOutcome = Infer<typeof vProbeOutcome>;
export type ChangedFile = Infer<typeof vChangedFile>;
