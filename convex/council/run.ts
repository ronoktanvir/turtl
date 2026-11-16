import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { gateFor, type Gate } from "../consent/gate";
import { estimateCostUsd, PROVIDER_KEYS } from "../routing/configs";
import { callModel, describeModel } from "../routing/models";
import { keyIsSet, NOTICE, type CouncilMember } from "./settings";
import { vConsolidation, vCouncilAnswer } from "./schema";

// The cross-model council: several models read the same evidence independently, then one step consolidates where they
// agree, where they disagree and what evidence is missing. Its output is an input to the proposal. It is never
// verification and never authorization.

export const MEMBER_TIMEOUT_MS = 75_000;
export const CONSOLIDATION_TIMEOUT_MS = 60_000;
export const MEMBER_MAX_OUTPUT_TOKENS = 6_000;
export const CONSOLIDATION_MAX_OUTPUT_TOKENS = 4_000;
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DAILY_LIMIT_PER_APP = 4;

const vEvidenceItem = v.object({ id: v.string(), kind: v.string(), title: v.string(), body: v.optional(v.string()) });

export type CouncilRequest = {
  caseId: Id<"cases">;
  stepId: Id<"steps">;
  stepAttemptId: Id<"stepAttempts">;
  purpose: "diagnosis" | "structural";
  question: string;
  failure?: string;
  facts: Record<string, unknown>;
  evidence: { id: string; kind: string; title: string; body?: string }[];
  context?: string;
};

export type CouncilResult =
  | { status: "completed"; reviewId: Id<"councilReviews">; summary: string; costUsd: number }
  | { status: "skipped" | "failed"; reviewId: Id<"councilReviews"> | null; summary: string; costUsd: number };

const MEMBER_PROMPT = [
  "You are one of several independent reviewers of an incident in a small app. Other reviewers see the same material; you do not see their answers.",
  "Use only the facts and evidence given. Do not invent observations. Never infer or rely on staging switches.",
  "hypothesis: your best explanation of the question, in at most two plain sentences, or say the evidence does not establish one.",
  "confidence: 0 to 1, how strongly the evidence supports your hypothesis.",
  "supportingEvidenceIds: ids from the evidence list that support it.",
  "missingEvidence: observations that are not in the material and would confirm or rule out your hypothesis.",
  "wouldDisprove: one observation that would show your hypothesis is wrong.",
  'Reply with a JSON object: {"hypothesis": string, "confidence": number, "supportingEvidenceIds": string[], "missingEvidence": string[], "wouldDisprove": string}.',
].join("\n");

const CONSOLIDATION_PROMPT = [
  "You consolidate independent reviews of the same incident evidence for the app's owner, who is not an engineer.",
  "The reviewers are labelled A, B, C and so on. Do not rank them by who they are; weigh what the evidence supports.",
  "agreements: points most reviewers make that the evidence supports, in plain sentences.",
  "disagreements: where reviewers differ, naming the labels and what each says.",
  "missingEvidence: the observations that would settle the disagreements or confirm the shared view, merged and deduplicated.",
  "summary: two or three plain sentences. Say plainly that agreement between reviewers is not proof and nothing has been verified.",
  'Reply with a JSON object: {"summary": string, "agreements": string[], "disagreements": string[], "missingEvidence": string[]}.',
].join("\n");

const strings = (value: unknown, limit = 8) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim()).slice(0, limit) : [];
const label = (index: number) => `Reviewer ${String.fromCharCode(65 + index)}`;

export const recent = internalQuery({
  args: { appId: v.id("apps"), caseId: v.id("cases"), since: v.number() },
  handler: async (ctx, { appId, caseId, since }) => {
    const reviews = await ctx.db.query("councilReviews").withIndex("by_app", (q) => q.eq("appId", appId).gte("startedAt", since)).collect();
    const counted = reviews.filter((review) => review.status === "completed" || review.status === "running");
    return {
      counted: counted.length,
      forCase: counted.find((review) => review.caseId === caseId)?._id ?? null,
      byFailure: counted.map((review) => ({ _id: review._id, failure: review.failure ?? null, startedAt: review.startedAt })),
    };
  },
});

export const open = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    purpose: v.union(v.literal("diagnosis"), v.literal("structural")),
    question: v.string(),
    failure: v.optional(v.string()),
    status: v.union(v.literal("running"), v.literal("skipped")),
    skippedReason: v.optional(v.string()),
    members: v.array(vCouncilAnswer),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.caseId);
    if (!row) throw new Error("The case does not exist.");
    const now = Date.now();
    return await ctx.db.insert("councilReviews", {
      ...args,
      appId: row.appId,
      notice: NOTICE,
      costUsd: 0,
      startedAt: now,
      ...(args.status === "skipped" && { finishedAt: now }),
    });
  },
});

export const close = internalMutation({
  args: {
    reviewId: v.id("councilReviews"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    members: v.array(vCouncilAnswer),
    consolidation: v.optional(vConsolidation),
    costUsd: v.number(),
  },
  handler: async (ctx, { reviewId, ...fields }) => {
    await ctx.db.patch(reviewId, { ...fields, finishedAt: Date.now() });
  },
});

type Runner = { caseId: Id<"cases">; stepId: Id<"steps">; stepAttemptId: Id<"stepAttempts"> };

async function runLogged(
  ctx: ActionCtx,
  gate: Gate,
  where: Runner,
  taskType: "council_member" | "council_consolidate",
  member: CouncilMember,
  reason: string,
  system: string,
  user: string,
  timeoutMs: number,
  maxOutputTokens: number,
) {
  const agentRunId: Id<"agentRuns"> = await ctx.runMutation(internal.routing.log.startRun, {
    ...where,
    taskType,
    config: {
      modelId: member.model,
      ...(member.reasoning && { reasoning: member.reasoning }),
      harnessVersion: "turtl-council-v1",
      promptVersion: taskType === "council_member" ? "council-member-v1" : "council-consolidate-v1",
      credentialRef: PROVIDER_KEYS[member.provider],
    },
    taskCharacteristics: { complexity: "ambiguous evidence", risk: "input to a proposal only", framework: "Expo and Convex", repositoryArea: "not inspected" },
    routingReason: reason,
    routing: { configKey: `council:${member.provider}/${member.model}`, configLabel: taskType === "council_member" ? "Council member" : "Council consolidation", provider: member.provider },
  });
  const answer = await callModel(gate, { ref: member, system, user, timeoutMs, maxOutputTokens });
  await ctx.runMutation(internal.routing.log.finishRun, {
    agentRunId,
    status: answer.ok ? "completed" : "failed",
    durationMs: answer.durationMs,
    ...(answer.usage && { usage: answer.usage }),
    ...(answer.costUsd !== undefined && { costUsd: answer.costUsd }),
    ...(!answer.ok && {
      error: `No answer: ${answer.reason}.`,
      outcome: answer.infra ? ("infra_failure" as const) : ("failed" as const),
      outcomeReason: answer.infra ? `Infrastructure: ${answer.reason}.` : `The answer could not be used: ${answer.reason}.`,
    }),
  });
  return { agentRunId, answer };
}

// The one entry point: the investigate handler calls it for an unsure diagnosis, and another step (such as the
// structural review) may call it through `internal.council.run.examine` for a structural hypothesis.
export async function examineWithCouncil(ctx: ActionCtx, request: CouncilRequest): Promise<CouncilResult> {
  const where = { caseId: request.caseId, stepId: request.stepId, stepAttemptId: request.stepAttemptId };
  const row = await ctx.runQuery(internal.protectedApp.records.caseContext, { caseId: request.caseId });
  const appId = row.case.appId;
  // A council on a diagnosis is part of finding an outage's cause; one on a structural hypothesis is not.
  const gate = gateFor(ctx, { caseId: request.caseId }, request.purpose === "diagnosis" ? "outage" : "account");
  const refusals = new Map<string, string | null>();
  const refusalFor = async (member: CouncilMember) => {
    if (!refusals.has(member.provider)) refusals.set(member.provider, await gate.blocked(member.provider));
    return refusals.get(member.provider) ?? null;
  };
  const settings = await ctx.runQuery(internal.council.settings.resolve, { appId });
  const user = JSON.stringify({ question: request.question, facts: request.facts, evidence: request.evidence, ...(request.context && { context: request.context }) });
  const inputTokens = Math.ceil((MEMBER_PROMPT.length + user.length) / 3);

  const answers: Infer<typeof vCouncilAnswer>[] = [];
  const runnable: CouncilMember[] = [];
  let estimate = estimateCostUsd(settings.consolidator.model, inputTokens * 2, CONSOLIDATION_MAX_OUTPUT_TOKENS) ?? 0;
  for (const member of settings.members) {
    const base = { provider: member.provider, model: member.model, label: describeModel(member), supportingEvidenceIds: [], missingEvidence: [] };
    if (!keyIsSet(member)) {
      answers.push({ ...base, status: "not_run", error: `Joins when ${PROVIDER_KEYS[member.provider]} is set on the deployment.` });
      continue;
    }
    const refused = await refusalFor(member);
    if (refused) {
      answers.push({ ...base, status: "not_run", error: `Not run: ${refused}.` });
      continue;
    }
    const cost = estimateCostUsd(member.model, inputTokens, MEMBER_MAX_OUTPUT_TOKENS);
    if (cost === undefined || estimate + cost > settings.maxCostUsd) {
      answers.push({ ...base, status: "not_run", error: cost === undefined ? "No list price is known for this model, so its cost cannot be bounded." : `Not run: it would take the council past its $${settings.maxCostUsd.toFixed(2)} limit.` });
      continue;
    }
    estimate += cost;
    runnable.push(member);
  }

  const since = Date.now() - REPEAT_WINDOW_MS;
  const recentReviews = await ctx.runQuery(internal.council.run.recent, { appId, caseId: request.caseId, since });
  const repeat = request.failure ? recentReviews.byFailure.find((review) => review.failure === request.failure) : undefined;
  const skippedReason = recentReviews.forCase
    ? "A council already examined this case."
    : repeat
      ? `A council examined the same failure ${((minutes) => (minutes === 1 ? "1 minute" : `${minutes} minutes`))(Math.max(1, Math.round((Date.now() - repeat.startedAt) / 60_000)))} ago; it is not repeated within a day.`
      : recentReviews.counted >= DAILY_LIMIT_PER_APP
        ? `The council already ran ${recentReviews.counted} times for this app today, its limit.`
        : runnable.length < 2
          ? `Only ${runnable.length} council member can run with the keys and cost limit this deployment has; a council needs at least two.`
          : null;
  if (skippedReason) {
    const reviewId: Id<"councilReviews"> = await ctx.runMutation(internal.council.run.open, {
      ...where, purpose: request.purpose, question: request.question, ...(request.failure && { failure: request.failure }),
      status: "skipped", skippedReason, members: answers,
    });
    return { status: "skipped", reviewId: repeat?._id ?? recentReviews.forCase ?? reviewId, summary: `No council ran: ${skippedReason}`, costUsd: 0 };
  }

  const reviewId: Id<"councilReviews"> = await ctx.runMutation(internal.council.run.open, {
    ...where, purpose: request.purpose, question: request.question, ...(request.failure && { failure: request.failure }),
    status: "running", members: answers,
  });
  const reason = `Council: ${request.purpose === "diagnosis" ? "the careful diagnosis was still unsure and no remembered recovery applied" : "a structural hypothesis was asked for"}, so ${runnable.length} models read the same evidence independently.`;
  const known = new Set(request.evidence.map((item) => item.id));
  const results = await Promise.all(
    runnable.map((member) => runLogged(ctx, gate, where, "council_member", member, reason, MEMBER_PROMPT, user, MEMBER_TIMEOUT_MS, MEMBER_MAX_OUTPUT_TOKENS)),
  );
  let costUsd = 0;
  results.forEach(({ agentRunId, answer }, index) => {
    const member = runnable[index];
    costUsd += answer.costUsd ?? 0;
    const base = { provider: member.provider, model: member.model, label: describeModel(member), agentRunId, durationMs: answer.durationMs, ...(answer.costUsd !== undefined && { costUsd: answer.costUsd }) };
    if (!answer.ok) {
      answers.push({ ...base, status: "failed", supportingEvidenceIds: [], missingEvidence: [], error: answer.reason });
      return;
    }
    const confidence = Number(answer.json.confidence);
    answers.push({
      ...base,
      status: "answered",
      hypothesis: typeof answer.json.hypothesis === "string" ? answer.json.hypothesis.trim() : "No hypothesis given.",
      ...(Number.isFinite(confidence) && { confidence: Math.min(1, Math.max(0, confidence)) }),
      supportingEvidenceIds: strings(answer.json.supportingEvidenceIds, 20).filter((id) => known.has(id)),
      missingEvidence: strings(answer.json.missingEvidence),
      ...(typeof answer.json.wouldDisprove === "string" && { wouldDisprove: answer.json.wouldDisprove.trim() }),
    });
  });

  const answered = answers.filter((item) => item.status === "answered");
  if (answered.length < 2) {
    await ctx.runMutation(internal.council.run.close, { reviewId, status: "failed", members: answers, costUsd });
    return { status: "failed", reviewId, summary: `The council did not complete: only ${answered.length} model answered.`, costUsd };
  }
  const reviews = answered.map((item, index) => ({
    reviewer: label(index), hypothesis: item.hypothesis, confidence: item.confidence ?? null,
    supportingEvidenceIds: item.supportingEvidenceIds, missingEvidence: item.missingEvidence, wouldDisprove: item.wouldDisprove ?? null,
  }));
  const { agentRunId, answer } = await runLogged(
    ctx, gate, where, "council_consolidate", settings.consolidator,
    `Consolidation of ${answered.length} independent council answers.`,
    CONSOLIDATION_PROMPT, JSON.stringify({ question: request.question, evidence: request.evidence, reviews }),
    CONSOLIDATION_TIMEOUT_MS, CONSOLIDATION_MAX_OUTPUT_TOKENS,
  );
  costUsd += answer.costUsd ?? 0;
  const consolidation = answer.ok
    ? {
        source: "model" as const, agentRunId, model: settings.consolidator.model,
        summary: typeof answer.json.summary === "string" ? answer.json.summary.trim() : "",
        agreements: strings(answer.json.agreements),
        disagreements: strings(answer.json.disagreements),
        missingEvidence: strings(answer.json.missingEvidence, 10),
      }
    : {
        source: "rules" as const, agentRunId,
        summary: `No model consolidated the answers (${answer.reason}), so each reviewer's hypothesis is listed as given.`,
        agreements: [],
        disagreements: reviews.map((item) => `${item.reviewer}: ${item.hypothesis}`),
        missingEvidence: [...new Set(answered.flatMap((item) => item.missingEvidence))].slice(0, 10),
      };
  await ctx.runMutation(internal.council.run.close, { reviewId, status: "completed", members: answers, consolidation, costUsd });
  return { status: "completed", reviewId, summary: consolidation.summary, costUsd };
}

export const examine = internalAction({
  args: {
    caseId: v.id("cases"),
    stepId: v.id("steps"),
    stepAttemptId: v.id("stepAttempts"),
    purpose: v.union(v.literal("diagnosis"), v.literal("structural")),
    question: v.string(),
    failure: v.optional(v.string()),
    facts: v.any(),
    evidence: v.array(vEvidenceItem),
    context: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CouncilResult> => await examineWithCouncil(ctx, args),
});
