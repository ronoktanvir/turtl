import { v } from "convex/values";
import type { Infer } from "convex/values";
import { vCriterion } from "../constants";
import { vCheckRun, vChecks } from "../prTracking/validators";


export const vViewport = v.object({ width: v.number(), height: v.number() });

export const vFixture = v.object({ id: v.string(), scoreCount: v.number() });

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
    transport: v.optional(v.union(v.literal("github_actions"), v.literal("local_browser"))),
    ref: v.optional(v.string()),
    viewport: vViewport,
    timeoutMinutes: v.number(),
  }),
  criteria: v.array(vCriterion),
  regressionCheck: v.optional(v.string()),
  protectedPaths: v.array(v.string()),
  sourcePaths: v.optional(v.array(v.string())),
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

export const vProbeResult = v.object({
  probeId: v.string(),
  verdict: v.union(v.literal("passed"), v.literal("failed")),
  failedStep: v.union(v.string(), v.null()),
  error: v.union(v.object({ code: v.string(), message: v.string() }), v.null()),
  revision: v.string(),
  environment: v.string(),
  fixture: vFixture,
  deadlineMs: v.number(),
  viewport: vViewport,
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
  screenshots: v.array(v.object({ file: v.string(), step: v.string(), caption: v.string(), capturedAt: v.number() })),
  cleanup: v.object({ ok: v.boolean(), deletedGames: v.number(), deletedScores: v.number() }),
});

export const vProbePurpose = v.union(v.literal("monitor"), v.literal("reproduce"), v.literal("verify"));
export const vProbeOutcome = v.union(v.literal("passed"), v.literal("failed"), v.literal("inconclusive"));

export const vProbeBaseline = v.object({ fixture: vFixture, deadlineMs: v.number(), viewport: vViewport });

export const vProbeRun = v.object({
  externalAppId: v.id("externalApps"),
  appId: v.id("apps"),
  purpose: vProbePurpose,
  probeId: v.string(),
  caseId: v.optional(v.id("cases")),
  stepAttemptId: v.optional(v.id("stepAttempts")),
  requestedAt: v.number(),
  deadlineAt: v.number(),
  config: vExternalApp,
  baseline: v.optional(vProbeBaseline),
  dispatchedAt: v.optional(v.number()),
  dispatchClaimedAt: v.optional(v.number()),
  transport: v.union(v.literal("github_actions"), v.literal("local_browser")),
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
export type ProbeBaseline = Infer<typeof vProbeBaseline>;
export type ProbePurpose = Infer<typeof vProbePurpose>;
export type BrowserScreenshot = Infer<typeof vBrowserScreenshot>;
export type Fixture = Infer<typeof vFixture>;
export type ProbeResult = Infer<typeof vProbeResult>;
export type ProbeStep = Infer<typeof vProbeStep>;
export type ProbeOutcome = Infer<typeof vProbeOutcome>;
export type ChangedFile = Infer<typeof vChangedFile>;

export const REQUIRED_CRITERIA = [
  "rounds_complete_within_deadline",
  "answers_and_streak_correct",
  "retry_not_applied_twice",
  "score_saved_once",
  "history_intact",
  "ranking_accurate_or_labeled",
] as const;

type Check = (value: unknown) => void;
const invalid = (): never => { throw new Error("Malformed probe result"); };
const text: Check = (value) => { if (typeof value !== "string" || !value.trim() || value.length > 4000) invalid(); };
const nonnegative: Check = (value) => { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(); };
const integer: Check = (value) => { nonnegative(value); if (!Number.isSafeInteger(value)) invalid(); };
const positive: Check = (value) => { integer(value); if (value === 0) invalid(); };
const boolean: Check = (value) => { if (typeof value !== "boolean") invalid(); };
const oneOf = (...values: unknown[]): Check => (value) => { if (!values.includes(value)) invalid(); };
const optional = (check: Check): Check => (value) => { if (value !== undefined) check(value); };
const nullable = (check: Check): Check => (value) => { if (value !== null) check(value); };
const list = (check: Check, max: number): Check => (value) => {
  if (!Array.isArray(value) || value.length > max) invalid();
  (value as unknown[]).forEach(check);
};
const object = (shape: Record<string, Check>): Check => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !Object.hasOwn(shape, key))) invalid();
  for (const [key, check] of Object.entries(shape)) check(row[key]);
};
const fixture = object({ id: text, scoreCount: positive });
const viewport = object({ width: positive, height: positive });
const sha: Check = (value) => { if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) invalid(); };
const screenshotFile: Check = (value) => {
  if (typeof value !== "string" || !/^screenshots\/[A-Za-z0-9][A-Za-z0-9_-]*\.png$/.test(value)) invalid();
};
const resultShape = object({
  probeId: text,
  verdict: oneOf("passed", "failed"),
  failedStep: nullable(text),
  error: nullable(object({ code: text, message: text })),
  revision: sha,
  environment: text,
  fixture,
  deadlineMs: positive,
  viewport,
  startedAt: integer,
  completedAt: integer,
  steps: list(object({
    step: text, verdict: oneOf("passed", "failed", "skipped"), detail: text,
    durationMs: optional(nonnegative),
    request: optional(object({
      method: oneOf("GET", "POST", "PUT", "PATCH", "DELETE"),
      path: (value) => { if (typeof value !== "string" || !/^\/[A-Za-z0-9/_-]+$/.test(value)) invalid(); },
      status: nullable((value) => { integer(value); if (Number(value) < 100 || Number(value) > 599) invalid(); }),
      outcome: oneOf("ok", "timeout", "error"), durationMs: nonnegative,
    })),
  }), 100),
  criteria: list(object({ id: text, status: oneOf("passed", "failed", "not_run"), detail: text }), 6),
  screenshots: list(object({ file: screenshotFile, step: text, caption: text, capturedAt: integer }), 8),
  cleanup: object({ ok: boolean, deletedGames: integer, deletedScores: integer }),
});

export function parseProbeResult(value: unknown): ProbeResult {
  resultShape(value);
  const result = value as ProbeResult;
  if (result.completedAt < result.startedAt || result.completedAt - result.startedAt > 15 * 60_000) invalid();
  if (result.steps.length === 0 || new Set(result.steps.map((step) => step.step)).size !== result.steps.length) invalid();
  if (result.criteria.length !== REQUIRED_CRITERIA.length || new Set(result.criteria.map((criterion) => criterion.id)).size !== REQUIRED_CRITERIA.length) invalid();
  if (REQUIRED_CRITERIA.some((id) => !result.criteria.some((criterion) => criterion.id === id))) invalid();
  if (!result.screenshots.length || new Set(result.screenshots.map((shot) => shot.file)).size !== result.screenshots.length) invalid();
  if (result.screenshots.some((shot) => shot.capturedAt < result.startedAt || shot.capturedAt > result.completedAt || !result.steps.some((step) => step.step === shot.step))) invalid();
  if (result.steps.some((step) => step.request?.outcome === "ok" && (step.request.status === null || step.request.status < 200 || step.request.status >= 300))) invalid();
  if (result.verdict === "passed") {
    if (result.failedStep !== null || result.error !== null || result.criteria.some((criterion) => criterion.status !== "passed")) invalid();
    if (result.steps.some((step) => step.verdict !== "passed") || result.screenshots.length < 2) invalid();
    const answers = result.steps.filter((step) => step.request?.method === "POST" && step.request.path === "/api/answer" && step.request.outcome === "ok");
    if (answers.length < 3 || answers.some((step) => step.request!.durationMs > result.deadlineMs)) invalid();
  } else {
    if (!result.failedStep || !result.error || !result.steps.some((step) => step.step === result.failedStep && step.verdict === "failed")) invalid();
    if (!result.criteria.some((criterion) => criterion.status === "failed")) invalid();
  }
  return result;
}

export function validateBaseline(value: ProbeBaseline): void {
  object({ fixture, deadlineMs: positive, viewport })(value);
}

export function evaluateProbe(input: {
  config: ExternalApp;
  probeId: string;
  purpose: ProbePurpose;
  revisionBefore?: string;
  revisionAfter?: string;
  expectedRevision?: string;
  baseline?: ProbeBaseline;
  result: ProbeResult;
}): { outcome: ProbeOutcome; reason: string } {
  const { config, result, baseline } = input;
  const inconclusive = (reason: string) => ({ outcome: "inconclusive" as const, reason });
  if (config.isTestDouble) return inconclusive("Test doubles cannot establish gameplay proof.");
  if (result.probeId !== input.probeId) return inconclusive("The artifact belongs to another probe.");
  if (!input.revisionBefore || !input.revisionAfter || input.revisionBefore !== result.revision || input.revisionAfter !== result.revision) return inconclusive("The before, browser and after revisions did not agree.");
  if (input.expectedRevision && result.revision !== input.expectedRevision) return inconclusive("The expected deployed revision was not tested.");
  if (result.environment !== config.environment) return inconclusive("The browser tested another environment.");
  if (result.viewport.width !== config.probe.viewport.width || result.viewport.height !== config.probe.viewport.height) return inconclusive("The browser viewport did not match the configured viewport.");
  if (input.purpose === "verify" && (!baseline || !input.expectedRevision)) return inconclusive("Verification needs the original fixture, deadline, viewport and expected deployed revision.");
  if (baseline && (result.fixture.id !== baseline.fixture.id || result.fixture.scoreCount !== baseline.fixture.scoreCount || result.deadlineMs !== baseline.deadlineMs || result.viewport.width !== baseline.viewport.width || result.viewport.height !== baseline.viewport.height)) return inconclusive("The original fixture, deadline or viewport changed.");
  if (!result.steps.some((step) => step.request?.method === "POST" && step.request.path === "/api/answer")) return inconclusive("No answer was submitted; a homepage is not gameplay proof.");
  if (!result.cleanup.ok) return inconclusive("The probe could not confirm safe cleanup.");
  return { outcome: result.verdict, reason: result.verdict === "passed" ? "All six gameplay criteria passed on the observed revision." : result.error!.message };
}
