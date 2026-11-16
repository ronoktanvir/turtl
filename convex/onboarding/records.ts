import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { vActionConfig, vCheck, vParameterConstraint } from "../constants";
import { vGithubSnapshot } from "../prTracking/validators";
import { vLiveCheck, vReadinessItem, vStack } from "./schema";

export const latestInspection = (ctx: QueryCtx, appId: Id<"apps">) =>
  ctx.db
    .query("onboardingInspections")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .order("desc")
    .first();

export const preparationFor = (ctx: QueryCtx, appId: Id<"apps">) =>
  ctx.db
    .query("onboardingPreparations")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .first();

export const inspectionContext = internalQuery({
  args: { inspectionId: v.id("onboardingInspections") },
  handler: async (ctx, { inspectionId }) => {
    const inspection = await ctx.db.get(inspectionId);
    return inspection && inspection.status === "running" ? { inspection, appId: inspection.appId } : null;
  },
});

export const startAgentRun = internalMutation({
  args: { appId: v.id("apps"), modelId: v.string(), promptVersion: v.string(), framework: v.string(), repositoryArea: v.string() },
  handler: async (ctx, { appId, modelId, promptVersion, framework, repositoryArea }) =>
    ctx.db.insert("agentRuns", {
      appId,
      taskType: "onboarding_inspection",
      config: { modelId, tools: ["github_read"], harnessVersion: "onboarding-v1", promptVersion },
      taskCharacteristics: { complexity: "medium", risk: "low", framework, repositoryArea },
      contextRefs: [],
      routingReason: "Fixed: the onboarding inspection always uses the deployment's OpenAI model (OPENAI_MODEL, else the default); nothing is routed.",
      status: "running",
      corrections: [],
    }),
});

export const finishAgentRun = internalMutation({
  args: {
    agentRunId: v.id("agentRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    durationMs: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { agentRunId, ...fields }) => ctx.db.patch(agentRunId, fields),
});

export const failInspection = internalMutation({
  args: { inspectionId: v.id("onboardingInspections"), error: v.string() },
  handler: async (ctx, { inspectionId, error }) =>
    ctx.db.patch(inspectionId, { status: "failed", error, finishedAt: Date.now() }),
});

// Stores the report and offers its suggestions as things that must never break, keeping what the owner wrote.
export const finishInspection = internalMutation({
  args: {
    inspectionId: v.id("onboardingInspections"),
    ref: v.string(),
    defaultBranch: v.string(),
    stack: vStack,
    items: v.array(vReadinessItem),
    suggestions: v.array(v.object({ text: v.string(), why: v.string() })),
    hasManifest: v.boolean(),
    filesRead: v.number(),
    judgedBy: v.union(v.literal("model"), v.literal("rules")),
    summary: v.optional(v.string()),
    fallbackReason: v.optional(v.string()),
    readNote: v.optional(v.string()),
    agentRunId: v.optional(v.id("agentRuns")),
  },
  handler: async (ctx, { inspectionId, ...fields }) => {
    const inspection = await ctx.db.get(inspectionId);
    if (!inspection || inspection.status !== "running") return;
    await ctx.db.patch(inspectionId, { ...fields, status: "done", finishedAt: Date.now() });
    const preparation = await preparationFor(ctx, inspection.appId);
    if (!preparation || preparation.answeredAt !== undefined || preparation.approvedAt !== undefined) return;
    await ctx.db.patch(preparation._id, {
      neverBreak: [
        ...preparation.neverBreak.filter((item) => !item.suggested),
        ...fields.suggestions.map((suggestion, index) => ({
          id: `suggested-${index + 1}`,
          text: suggestion.text,
          why: suggestion.why,
          suggested: true,
          addCheck: true,
        })),
      ],
    });
  },
});

export const forPreparation = internalQuery({
  args: { preparationId: v.id("onboardingPreparations") },
  handler: async (ctx, { preparationId }) => {
    const preparation = await ctx.db.get(preparationId);
    if (!preparation) return null;
    const app = await ctx.db.get(preparation.appId);
    const inspection = preparation.inspectionId ? await ctx.db.get(preparation.inspectionId) : null;
    return app ? { preparation, app, inspection } : null;
  },
});

export const forApp = internalQuery({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const appId = ctx.db.normalizeId("apps", projectId);
    return appId ? await preparationFor(ctx, appId) : null;
  },
});

/** More open preparation pull requests than the cron follows in one run; the rest wait for the next minute. */
const ACTIVE_PER_RUN = 100;

// Preparations approved and not yet settled: the ones the cron keeps fresh, oldest approval first, a bounded number.
export const active = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("onboardingPreparations")
      .withIndex("by_settled_and_approved", (q) => q.eq("settledAt", undefined).gt("approvedAt", 0))
      .take(ACTIVE_PER_RUN),
});

export const recordThread = internalMutation({
  args: { id: v.id("onboardingPreparations"), capyThreadId: v.string(), brief: v.string() },
  handler: async (ctx, { id, capyThreadId, brief }) => ctx.db.patch(id, { capyThreadId, brief, requestedAt: Date.now() }),
});

// With accounts on, the preparation could not start (no coding agent, or a repository the owner has not connected).
// Nothing was sent, so the approval is handed back with the reason and the owner can approve again once it is fixed.
export const refuseStart = internalMutation({
  args: { id: v.id("onboardingPreparations"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, reason }) => {
    const row = await ctx.db.get(id);
    if (!row || row.capyThreadId || row.settledAt !== undefined) return null;
    await ctx.db.patch(id, { blocked: reason, approvedAt: undefined, inspectionId: undefined, requestId: undefined, repo: undefined, baseBranch: undefined });
    return null;
  },
});

export const failOpening = internalMutation({
  args: { id: v.id("onboardingPreparations"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined) return;
    await ctx.db.patch(id, { openError: error, settledAt: Date.now() });
  },
});

export const setCapyCursor = internalMutation({
  args: { id: v.id("onboardingPreparations"), cursor: v.string() },
  handler: async (ctx, { id, cursor }) => ctx.db.patch(id, { capyCursor: cursor }),
});

export const setNumber = internalMutation({
  args: { id: v.id("onboardingPreparations"), number: v.number() },
  handler: async (ctx, { id, number }) => ctx.db.patch(id, { number }),
});

export const recordSyncError = internalMutation({
  args: { id: v.id("onboardingPreparations"), error: v.string() },
  handler: async (ctx, { id, error }) => ctx.db.patch(id, { syncError: error, syncedAt: Date.now() }),
});

// Writes GitHub's latest view. A merge settles the preparation and starts the live checks; it is credited to
// the owner only when it follows their tap in turtl.
export const applySnapshot = internalMutation({
  args: { id: v.id("onboardingPreparations"), snapshot: vGithubSnapshot, mergeCommitSha: v.optional(v.string()) },
  handler: async (ctx, { id, snapshot, mergeCommitSha }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Preparation not found.");
    await ctx.db.patch(id, { snapshot, syncedAt: Date.now(), syncError: undefined });
    if (row.settledAt !== undefined || snapshot.state === "open") return;
    const now = Date.now();
    if (snapshot.state === "closed") {
      await ctx.db.patch(id, { settledAt: now });
      return;
    }
    const ref = mergeCommitSha ?? row.mergeCommitSha;
    await ctx.db.patch(id, {
      settledAt: now,
      mergedAt: now,
      mergedBy: row.mergeRequestedAt !== undefined ? "owner" : "github",
      ...(ref && { mergeCommitSha: ref }),
      registration: { status: "checking", checks: [], ...(ref && { ref }) },
    });
    await ctx.scheduler.runAfter(0, internal.onboarding.prepare.register, { preparationId: id });
  },
});

export const beginMerge = internalMutation({
  args: { id: v.id("onboardingPreparations") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.settledAt !== undefined) return false;
    await ctx.db.patch(id, { mergeRequestedAt: Date.now() });
    return true;
  },
});

export const clearMergeRequest = internalMutation({
  args: { id: v.id("onboardingPreparations") },
  handler: async (ctx, { id }) => ctx.db.patch(id, { mergeRequestedAt: undefined }),
});

export const failRegistration = internalMutation({
  args: { id: v.id("onboardingPreparations"), ref: v.optional(v.string()), error: v.string() },
  handler: async (ctx, { id, ref, error }) => {
    const requestedAt = (await ctx.db.get(id))?.registration?.requestedAt;
    await ctx.db.patch(id, { registration: { status: "failed", error, checks: [], checkedAt: Date.now(), ...(ref && { ref }), ...(requestedAt !== undefined && { requestedAt }) } });
  },
});

/** More journeys than one project registers; it bounds the lookup by name. */
const JOURNEY_SCAN = 100;

const vJourneyEntry = v.object({ name: v.string(), description: v.string(), check: vCheck, checkVersion: v.string() });
const vActionEntry = v.object({
  type: v.string(),
  name: v.string(),
  description: v.string(),
  config: vActionConfig,
  parameterConstraints: v.array(vParameterConstraint),
});

async function upsertJourney(ctx: MutationCtx, appId: Id<"apps">, entry: Omit<Doc<"journeys">, "_id" | "_creationTime" | "appId">) {
  const existing = (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).take(JOURNEY_SCAN)).find(
    (journey) => journey.name === entry.name,
  );
  if (existing) {
    await ctx.db.patch(existing._id, entry);
    return existing._id;
  }
  return await ctx.db.insert("journeys", { appId, ...entry });
}

// Registers the checks and switches that answered on the live app, and stores every check's result. A check
// that does not answer now is never registered; one registered by an earlier check stays, and says so.
export const register = internalMutation({
  args: {
    id: v.id("onboardingPreparations"),
    ref: v.string(),
    note: v.optional(v.string()),
    checks: v.array(
      v.object({
        result: vLiveCheck,
        journey: v.optional(vJourneyEntry),
        action: v.optional(vActionEntry),
        passedAt: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { id, ref, note, checks }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Preparation not found.");
    const requestedAt = row.registration?.requestedAt;
    const results = [];
    for (const { result, journey, action, passedAt } of checks) {
      if (journey) {
        const journeyId = await upsertJourney(ctx, row.appId, { ...journey, ...(passedAt !== undefined && { lastPassedAt: passedAt }) });
        results.push({ ...result, journeyId });
      } else if (action) {
        const existing = (
          await ctx.db
            .query("actionCatalog")
            .withIndex("by_app_and_type", (q) => q.eq("appId", row.appId).eq("type", action.type))
            .take(JOURNEY_SCAN)
        ).find((entry) => entry.name === action.name);
        const fields = { ...action, reversible: true };
        const actionCatalogId = existing?._id ?? (await ctx.db.insert("actionCatalog", { appId: row.appId, ...fields }));
        if (existing) await ctx.db.patch(existing._id, fields);
        results.push({ ...result, actionCatalogId });
      } else if (result.kind === "flag" || result.kind === "recovery_hook") {
        const earlier = (
          await ctx.db
            .query("actionCatalog")
            .withIndex("by_app_and_type", (q) => q.eq("appId", row.appId).eq("type", result.kind === "flag" ? "set_feature_flag" : "recovery_switch"))
            .take(JOURNEY_SCAN)
        ).find((entry) => entry.name === result.name);
        results.push(earlier ? { ...result, actionCatalogId: earlier._id, detail: `${result.detail} It stays registered from an earlier check.` } : result);
      } else {
        const earlier = (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", row.appId)).take(JOURNEY_SCAN)).find((journey) => journey.name === result.name);
        results.push(earlier ? { ...result, journeyId: earlier._id, detail: `${result.detail} It stays registered from an earlier check.` } : result);
      }
    }
    await ctx.db.patch(id, {
      registration: { status: "done", ref, checks: results, checkedAt: Date.now(), ...(note && { note }), ...(requestedAt !== undefined && { requestedAt }) },
    });
  },
});
