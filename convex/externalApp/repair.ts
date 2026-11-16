import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { CLOSED_CASE_STATUSES, type CriterionResult } from "../constants";
import { readPullRequest, repoFromUrl } from "../prTracking/github";
import type { GithubSnapshot } from "../prTracking/validators";
import type { HandlerInput, HandlerResult } from "../runner/contract";
import { readGithubJson } from "./agent";
import { readRevision, startProbe } from "./probes";
import { REQUIRED_CRITERIA, vRepairProof } from "./validators";

declare const process: { env: Record<string, string | undefined> };

type Proof = Doc<"repairProofs">;
type Baseline = { fixture: { id: string; scoreCount: number }; deadlineMs: number; viewport: { width: number; height: number } };
type Context = {
  externalApp: Doc<"externalApps">;
  action: Doc<"actions">;
  pull: Doc<"pullRequests">;
  attempt: Doc<"stepAttempts">;
  baseline: Doc<"probeRuns"> | null;
  proof: Proof | null;
};
type Assessment = { verdict: "passed" | "failed" | "inconclusive"; reason: string; criteria: Omit<CriterionResult, "evidenceIds">[] };

async function loadContext(ctx: QueryCtx, caseId: Id<"cases">, attemptId: Id<"stepAttempts">): Promise<Context | null> {
  const row = await ctx.db.get(caseId);
  const attempt = await ctx.db.get(attemptId);
  const step = attempt && await ctx.db.get(attempt.stepId);
  if (!row || !attempt || attempt.caseId !== caseId || !step || step.purpose !== "verify" ||
      step.currentAttemptId !== attemptId || !["running", "waiting"].includes(attempt.status) ||
      (CLOSED_CASE_STATUSES as readonly string[]).includes(row.status)) return null;
  const externalApp = await ctx.db.query("externalApps").withIndex("by_app", (q) => q.eq("appId", row.appId)).unique();
  const action = await ctx.db.query("actions").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("desc").first();
  if (!externalApp || externalApp.journeyId !== row.journeyId || !action || action.status !== "completed" ||
      action.environment !== externalApp.environment) return null;
  const config = action.executionPayload.config;
  const pull = await ctx.db.query("pullRequests").withIndex("by_action", (q) => q.eq("actionId", action._id)).unique();
  if (!pull || pull.caseId !== caseId || pull.number === undefined || config.kind !== "capy" ||
      repoFromUrl(config.repoUrl)?.toLowerCase() !== externalApp.repo.toLowerCase() ||
      pull.repo.toLowerCase() !== externalApp.repo.toLowerCase() || config.baseBranch !== externalApp.baseBranch ||
      pull.baseBranch !== externalApp.baseBranch) return null;
  const probes = await ctx.db.query("probeRuns").withIndex("by_case", (q) => q.eq("caseId", caseId)).order("asc").collect();
  const baseline = probes.find((probe) => probe.externalAppId === externalApp._id && probe.appId === row.appId &&
    probe.purpose !== "verify" && probe.outcome === "failed" && probe.requestedAt <= action.requestedAt &&
    probe.result?.environment === externalApp.environment && probe.result.revision === probe.revisionBefore &&
    probe.result.revision === probe.revisionAfter) ?? null;
  const proofs = await ctx.db.query("repairProofs").withIndex("by_case", (q) => q.eq("caseId", caseId)).collect();
  const proof = proofs.find((candidate) => candidate.stepAttemptId === attemptId) ?? null;
  if (proof && (proof.actionId !== action._id || proof.pullRequestId !== pull._id || proof.externalAppId !== externalApp._id)) return null;
  return { externalApp, action, pull, attempt, baseline, proof };
}

export const verificationContext = internalQuery({
  args: { caseId: v.id("cases"), attemptId: v.id("stepAttempts") },
  handler: async (ctx, { caseId, attemptId }): Promise<Context | null> => loadContext(ctx, caseId, attemptId),
});

export const proofContext = internalQuery({
  args: { proofId: v.id("repairProofs") },
  handler: async (ctx, { proofId }): Promise<(Context & { proof: Proof }) | null> => {
    const proof = await ctx.db.get(proofId);
    if (!proof?.stepAttemptId) return null;
    const context = await loadContext(ctx, proof.caseId, proof.stepAttemptId);
    if (!context || context.proof?._id !== proofId || context.action._id !== proof.actionId ||
        context.pull._id !== proof.pullRequestId || context.externalApp._id !== proof.externalAppId) return null;
    return { ...context, proof };
  },
});

export function candidateFact(snapshot: GithubSnapshot, regressionCheck: string | undefined,
  regressionStatus: "passed" | "failed" | "pending" | "missing", observedAt: number): Proof["candidate"] {
  const status = snapshot.checks === "failing" || regressionStatus === "failed" ? "failed" :
    snapshot.checks === "pending" || regressionStatus === "pending" ? "pending" :
    snapshot.checks === "passing" && regressionCheck && regressionStatus === "passed" ? "passed" : "not_tested";
  return { status, headSha: snapshot.headSha, checks: snapshot.checks, checkRuns: snapshot.checkRuns,
    ...(regressionCheck && { regressionCheck: { name: regressionCheck, status: regressionStatus } }), observedAt };
}

export function baselineConditions(run: Doc<"probeRuns"> | null): Baseline | null {
  const result = run?.result;
  if (!result?.fixture || !result.fixture.id || !result.viewport || !Number.isFinite(result.fixture.scoreCount) || result.fixture.scoreCount < 1 ||
      !Number.isFinite(result.deadlineMs) || result.deadlineMs! <= 0 ||
      !Number.isFinite(result.viewport.width) || !Number.isFinite(result.viewport.height) ||
      result.viewport.width <= 0 || result.viewport.height <= 0) return null;
  return { fixture: result.fixture, deadlineMs: result.deadlineMs!, viewport: result.viewport };
}

export function assessGameplay(
  run: Pick<Doc<"probeRuns">, "outcome" | "reason" | "result" | "revisionBefore" | "revisionAfter" | "expectedRevision">,
  baseline: Baseline | null,
  expectedSha: string,
  environment: string,
): Assessment {
  const inconclusive = (reason: string): Assessment => ({ verdict: "inconclusive", reason,
    criteria: REQUIRED_CRITERIA.map((criterionId) => ({ criterionId, status: "uncovered", summary: reason })) });
  const result = run.result;
  if (!baseline) return inconclusive("The original failed gameplay run has no comparable fixture, deadline and viewport.");
  if (!result || run.outcome === "inconclusive" || !run.outcome) return inconclusive(run.reason ?? "The gameplay evidence is unavailable.");
  if (run.expectedRevision !== expectedSha || run.revisionBefore !== expectedSha ||
      run.revisionAfter !== expectedSha || result.revision !== expectedSha || result.environment !== environment) {
    return inconclusive("The gameplay run did not observe the exact merged revision in the registered environment throughout.");
  }
  if (result.fixture?.id !== baseline.fixture.id || !Number.isFinite(result.fixture.scoreCount) ||
      result.fixture.scoreCount < baseline.fixture.scoreCount) return inconclusive("The fixture changed or contains fewer historical scores than the original failed run.");
  if (result.deadlineMs !== baseline.deadlineMs) return inconclusive("The gameplay deadline differs from the original failed run.");
  if (result.viewport?.width !== baseline.viewport.width || result.viewport.height !== baseline.viewport.height) {
    return inconclusive("The browser viewport differs from the original failed run.");
  }
  if (!result.cleanup?.ok) return inconclusive("The probe did not confirm safe cleanup of only its own test data.");
  const ids = result.criteria.map((criterion) => criterion.id);
  if (ids.length !== REQUIRED_CRITERIA.length || new Set(ids).size !== ids.length ||
      REQUIRED_CRITERIA.some((id) => !ids.includes(id))) return inconclusive("The probe did not report each of the six required gameplay criteria exactly once.");
  const criteria: Assessment["criteria"] = REQUIRED_CRITERIA.map((criterionId) => {
    const criterion = result.criteria.find((entry) => entry.id === criterionId)!;
    return { criterionId, status: criterion.status === "not_run" ? "uncovered" : criterion.status, summary: criterion.detail };
  });
  const passed = criteria.every((criterion) => criterion.status === "passed");
  if (passed) {
    if (result.steps.some((step) => step.verdict === "failed")) return inconclusive("The probe reported passing criteria alongside a failed gameplay step.");
    const requests = result.steps.filter((step) => step.request?.method === "POST" && step.request.path === "/api/answer");
    if (requests.some((step) => step.request!.outcome !== "ok" || step.request!.status === null ||
        step.request!.status < 200 || step.request!.status >= 300 || !Number.isFinite(step.request!.durationMs) ||
        step.request!.durationMs < 0 || step.request!.durationMs > baseline.deadlineMs)) {
      return inconclusive("The claimed gameplay pass contains an unsuccessful answer request or one outside the original deadline.");
    }
    const answers = result.steps.filter((step) => step.verdict === "passed" && step.request?.method === "POST" &&
      step.request.path === "/api/answer" && step.request.outcome === "ok" && step.request.status !== null &&
      step.request.status >= 200 && step.request.status < 300 && Number.isFinite(step.request.durationMs) &&
      step.request.durationMs >= 0 && step.request.durationMs <= baseline.deadlineMs);
    if (new Set(answers.map((step) => step.step)).size < 2) return inconclusive("The evidence does not show multiple real answer requests completing within the original deadline.");
    if (result.verdict !== "passed" || run.outcome !== "passed") return inconclusive("The reported gameplay outcome contradicts its criteria.");
    return { verdict: "passed", criteria, reason: "All six gameplay criteria passed on the deployed merge commit with the original fixture, deadline and viewport." };
  }
  return { verdict: criteria.some((criterion) => criterion.status === "failed") ? "failed" : "inconclusive",
    criteria, reason: "Gameplay was not fully verified: " + criteria.filter((criterion) => criterion.status !== "passed").map((criterion) => criterion.summary).join(" ") };
}

export async function beginVerification(ctx: ActionCtx, input: HandlerInput): Promise<HandlerResult> {
  const context: Context | null = await ctx.runQuery(internal.externalApp.repair.verificationContext, { caseId: input.case._id, attemptId: input.attempt._id });
  if (!context) return { status: "failed", error: "No completed, approved code-change action and bound PR exist for this external-app verification attempt." };
  if (!context.proof) {
    const { pull, externalApp } = context;
    const token = process.env[externalApp.githubCredentialRef];
    if (!token) return { status: "failed", error: `Cannot verify a real merge: ${externalApp.githubCredentialRef} is not configured.` };
    const read = await readPullRequest(token, externalApp.repo, pull.number!);
    if (!read.ok) return { status: "failed", error: `Cannot verify a real merge: ${read.message}` };
    const { snapshot, mergeCommitSha } = read.body;
    if (snapshot.state !== "merged" || !/^[a-f0-9]{40}$/i.test(mergeCommitSha ?? "")) {
      return { status: "failed", error: "GitHub has not confirmed a merged PR and its exact merge commit. No deployment or gameplay success was inferred." };
    }
    let regressionStatus: "passed" | "failed" | "pending" | "missing" = "missing";
    if (externalApp.regressionCheck) {
      const checks = await readGithubJson<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(token,
        `/repos/${externalApp.repo}/commits/${snapshot.headSha}/check-runs?per_page=100`);
      const runs = checks.ok ? checks.body.check_runs.filter((run) => run.name === externalApp.regressionCheck) : [];
      if (runs.length) regressionStatus = runs.some((run) => run.status !== "completed") ? "pending" :
        runs.every((run) => run.conclusion === "success") ? "passed" : "failed";
    }
    const now = Date.now();
    await ctx.runMutation(internal.externalApp.repair.initialize, { row: {
      caseId: input.case._id, externalAppId: externalApp._id, actionId: context.action._id, pullRequestId: pull._id,
      stepAttemptId: input.attempt._id, candidate: candidateFact(snapshot, externalApp.regressionCheck, regressionStatus, now),
      deployment: { status: "waiting", expectedSha: mergeCommitSha!, environment: externalApp.environment, waitingSince: now },
      gameplay: { status: "not_run" },
    } });
  }
  await ctx.runMutation(internal.externalApp.records.holdClock, { attemptId: input.attempt._id });
  return { status: "waiting", caseStatus: "waiting_for_deploy", summary: "The candidate checks, merged deployment and post-deployment gameplay are separate facts. Waiting for the exact merge commit before playing the game again." };
}

export const initialize = internalMutation({
  args: { row: vRepairProof },
  handler: async (ctx, { row }): Promise<Id<"repairProofs">> => {
    if (!row.stepAttemptId) throw new Error("A repair proof must belong to a verify attempt.");
    const context = await loadContext(ctx, row.caseId, row.stepAttemptId);
    if (!context || context.externalApp._id !== row.externalAppId || context.action._id !== row.actionId || context.pull._id !== row.pullRequestId) {
      throw new Error("The repair proof is not bound to the approved action, real PR, app and current case attempt.");
    }
    if (context.proof) return context.proof._id;
    const proofId = await ctx.db.insert("repairProofs", row);
    await ctx.db.insert("evidence", { caseId: row.caseId, stepId: context.attempt.stepId, stepAttemptId: row.stepAttemptId,
      kind: "candidate_checks", title: `GitHub candidate testing: ${row.candidate.status}. This is not deployment or gameplay verification.`,
      body: JSON.stringify({ origin: "github", pullRequestId: row.pullRequestId, repo: context.pull.repo, number: context.pull.number, candidate: row.candidate }),
      sourceRef: `https://github.com/${context.pull.repo}/pull/${context.pull.number}`, observedAt: row.candidate.observedAt,
      environment: context.action.environment, revision: { commitSha: row.candidate.headSha } });
    await ctx.scheduler.runAfter(0, internal.externalApp.repair.checkDeployment, { proofId });
    return proofId;
  },
});

export const checkDeployment = internalAction({
  args: { proofId: v.id("repairProofs") },
  handler: async (ctx, { proofId }): Promise<void> => {
    const context: (Context & { proof: Proof }) | null = await ctx.runQuery(internal.externalApp.repair.proofContext, { proofId });
    if (!context || context.proof.gameplay.verificationId || context.proof.deployment.status === "not_confirmed") return;
    if (context.proof.deployment.status === "waiting") {
      const revision = await readRevision(context.externalApp);
      const ready: boolean = await ctx.runMutation(internal.externalApp.repair.observeDeployment, { proofId,
        ...(revision.ok ? { revision: revision.body.revision, environment: revision.body.environment } : { error: revision.message }) });
      if (!ready) return;
    }
    const baseline = baselineConditions(context.baseline);
    if (!baseline) {
      await ctx.runMutation(internal.externalApp.repair.unavailable, { proofId, reason: "The original failed run has no comparable large fixture, deadline and viewport. No gameplay probe was started." });
      return;
    }
    try {
      const probeRunId = await startProbe(ctx, { externalApp: context.externalApp, purpose: "verify", caseId: context.proof.caseId,
        stepAttemptId: context.attempt._id, expectedRevision: context.proof.deployment.expectedSha, baseline });
      await ctx.runMutation(internal.externalApp.repair.linkProbe, { proofId, probeRunId });
      await completeVerification(ctx, probeRunId);
    } catch (error) {
      await ctx.runMutation(internal.externalApp.repair.unavailable, { proofId,
        reason: `The post-deployment probe could not be started: ${error instanceof Error ? error.name : "unknown error"}.` });
    }
  },
});

export const observeDeployment = internalMutation({
  args: { proofId: v.id("repairProofs"), revision: v.optional(v.string()), environment: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args): Promise<boolean> => {
    const proof = await ctx.db.get(args.proofId);
    if (!proof?.stepAttemptId || proof.deployment.status === "not_confirmed" || proof.gameplay.verificationId) return false;
    const context = await loadContext(ctx, proof.caseId, proof.stepAttemptId);
    if (!context || context.proof?._id !== proof._id) return false;
    if (proof.deployment.status === "confirmed") return true;
    const now = Date.now();
    const timeout = context.externalApp.deployTimeoutMinutes * 60_000;
    const expired = !Number.isFinite(timeout) || timeout <= 0 || now >= proof.deployment.waitingSince + timeout;
    const matched = args.revision === proof.deployment.expectedSha && args.environment === proof.deployment.environment;
    const reason = expired ? "The deployment deadline elapsed without confirming the exact merged revision in the registered environment." :
      matched ? "The revision endpoint reports the exact merge commit and registered environment." :
      args.error ?? `Waiting for ${proof.deployment.expectedSha}; observed ${args.revision ?? "no revision"} in ${args.environment ?? "an unknown environment"}.`;
    const deployment: Proof["deployment"] = { ...proof.deployment,
      status: expired ? "not_confirmed" : matched ? "confirmed" : "waiting", lastCheckedAt: now, reason,
      ...(args.revision && { observedSha: args.revision }), ...(!expired && matched && { confirmedAt: now }) };
    await ctx.db.patch(proof._id, { deployment });
    if (expired) await finishVerification(ctx, { ...proof, deployment }, context, null, reason);
    else if (!matched) await ctx.scheduler.runAfter(Math.min(10_000, proof.deployment.waitingSince + timeout - now), internal.externalApp.repair.checkDeployment, { proofId: proof._id });
    return !expired && matched;
  },
});

export const linkProbe = internalMutation({
  args: { proofId: v.id("repairProofs"), probeRunId: v.id("probeRuns") },
  handler: async (ctx, { proofId, probeRunId }) => {
    const proof = await ctx.db.get(proofId);
    const run = await ctx.db.get(probeRunId);
    if (!proof || !run || proof.gameplay.verificationId) return;
    if (proof.deployment.status !== "confirmed" || run.caseId !== proof.caseId || run.stepAttemptId !== proof.stepAttemptId ||
        run.externalAppId !== proof.externalAppId || run.expectedRevision !== proof.deployment.expectedSha || run.purpose !== "verify") {
      throw new Error("The gameplay probe is not bound to this confirmed repair deployment and case attempt.");
    }
    if (proof.gameplay.probeRunId && proof.gameplay.probeRunId !== probeRunId) throw new Error("A different probe already belongs to this repair proof.");
    await ctx.db.patch(proofId, { gameplay: { status: "running", probeRunId } });
  },
});

async function finishVerification(ctx: MutationCtx, proof: Proof, context: Context, run: Doc<"probeRuns"> | null, unavailableReason?: string) {
  if (proof.gameplay.verificationId || !proof.stepAttemptId) return;
  const assessment = run ? assessGameplay(run, baselineConditions(context.baseline), proof.deployment.expectedSha, proof.deployment.environment) :
    { verdict: "inconclusive" as const, reason: unavailableReason ?? "Gameplay verification is unavailable.",
      criteria: REQUIRED_CRITERIA.map((criterionId) => ({ criterionId, status: "uncovered" as const, summary: unavailableReason ?? "Not run." })) };
  const completedAt = Date.now();
  const evidenceId = await ctx.db.insert("evidence", { caseId: proof.caseId, stepId: context.attempt.stepId, stepAttemptId: proof.stepAttemptId,
    kind: "post_deploy_gameplay", title: `turtl verification: ${assessment.verdict}. ${assessment.reason}`,
    body: JSON.stringify({ origin: "turtl", pullRequestId: proof.pullRequestId, baselineProbeRunId: context.baseline?._id,
      baseline: baselineConditions(context.baseline), deployment: proof.deployment,
      ...(run && { probeRunId: run._id, githubRunUrl: run.githubRunUrl, result: run.result, outcome: run.outcome }) }),
    ...(run?.githubRunUrl && { url: run.githubRunUrl }), sourceRef: `repairProofs:${proof._id}`,
    observedAt: completedAt, environment: proof.deployment.environment, revision: { commitSha: proof.deployment.expectedSha } });
  const criterionResults = assessment.criteria.map((criterion) => ({ ...criterion, evidenceIds: [evidenceId] }));
  const verificationId = await ctx.db.insert("verifications", { caseId: proof.caseId, journeyId: context.externalApp.journeyId,
    actionId: proof.actionId, stepAttemptId: proof.stepAttemptId, phase: "after_deploy", environment: proof.deployment.environment,
    revision: { commitSha: proof.deployment.expectedSha }, checkVersion: context.externalApp.probe.workflow,
    criteriaVersion: "listener-ladder-six-v1", criterionResults, evidenceIds: [evidenceId],
    startedAt: proof.deployment.waitingSince, completedAt, verdict: assessment.verdict,
    coverage: { coveredCriterionIds: criterionResults.filter((criterion) => criterion.status !== "uncovered").map((criterion) => criterion.criterionId),
      uncoveredCriterionIds: criterionResults.filter((criterion) => criterion.status === "uncovered").map((criterion) => criterion.criterionId) }, summary: assessment.reason });
  await ctx.db.patch(proof._id, { gameplay: { status: assessment.verdict, verificationId, completedAt, reason: assessment.reason,
    ...(run && { probeRunId: run._id }) } });
  const restored = assessment.verdict === "passed" && proof.deployment.status === "confirmed" && proof.candidate.status === "passed";
  const summary = restored ? `Game restored: ${assessment.reason}` :
    `Not restored: ${assessment.reason}${proof.candidate.status !== "passed" ? ` Candidate regression testing is ${proof.candidate.status}, not passed.` : ""}`;
  const result: HandlerResult = restored ? { status: "done", caseStatus: "restored", summary,
    handoff: { note: summary, refs: [{ kind: "verification", id: verificationId }, { kind: "evidence", id: evidenceId }] }, output: { verificationId, repairProofId: proof._id } } :
    { status: "failed", error: summary };
  await ctx.scheduler.runAfter(0, internal.runner.run.recordResult, { attemptId: proof.stepAttemptId, result });
}

export const unavailable = internalMutation({
  args: { proofId: v.id("repairProofs"), reason: v.string() },
  handler: async (ctx, { proofId, reason }) => {
    const proof = await ctx.db.get(proofId);
    if (!proof?.stepAttemptId || proof.gameplay.verificationId) return;
    const context = await loadContext(ctx, proof.caseId, proof.stepAttemptId);
    if (context?.proof?._id === proofId) await finishVerification(ctx, proof, context, null, reason);
  },
});

export const finishProbe = internalMutation({
  args: { probeRunId: v.id("probeRuns") },
  handler: async (ctx, { probeRunId }): Promise<void> => {
    const run = await ctx.db.get(probeRunId);
    if (!run?.caseId || !run.stepAttemptId || run.purpose !== "verify" || run.completedAt === undefined || !run.outcome) return;
    const context = await loadContext(ctx, run.caseId, run.stepAttemptId);
    const proof = context?.proof;
    if (!context || !proof || proof.gameplay.verificationId || proof.deployment.status !== "confirmed" ||
        proof.externalAppId !== run.externalAppId || run.appId !== context.externalApp.appId ||
        (proof.gameplay.probeRunId && proof.gameplay.probeRunId !== probeRunId) || run.expectedRevision !== proof.deployment.expectedSha) return;
    await finishVerification(ctx, proof, context, run);
  },
});

export async function completeVerification(ctx: ActionCtx, probeRunId: Id<"probeRuns">): Promise<void> {
  await ctx.runMutation(internal.externalApp.repair.finishProbe, { probeRunId });
}
