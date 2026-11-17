import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { vActionConfig, vCheck, vParameterConstraint, vProbe } from "../constants";
import { FOLLOW_BATCH, FOLLOW_LEASE_MS, nextFollowAt } from "../prTracking/follow";
import { vGithubSnapshot } from "../prTracking/validators";
import { checkSoon, liveChecks, probeOf } from "../protectedApp/watching";
import { MANIFEST_CHECK_VERSION, MANIFEST_FILE } from "./detect";
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

/** The preparation cron's interval (convex/crons.ts). */
export const PREPARATION_EVERY_MS = 60_000;

export const get = internalQuery({
  args: { id: v.id("onboardingPreparations") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

/** The next-sync time of a preparation turtl does not follow (not approved): later than any time, so never due. */
export const NOT_FOLLOWED = Number.MAX_SAFE_INTEGER;

// Approved preparations not yet settled whose next read has come, oldest due first, each leased while its read runs
// (prepare.ts, syncDue). An approval sets the first next-sync time. A row from before those were kept has none: an
// approved one is due now, and one not approved is marked as not followed, so it leaves the rows read here.
export const claimDue = internalMutation({
  args: {},
  returns: v.object({ ids: v.array(v.id("onboardingPreparations")), more: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const unknown = await ctx.db
      .query("onboardingPreparations")
      .withIndex("by_settled_and_next_sync", (q) => q.eq("settledAt", undefined).eq("nextSyncAt", undefined))
      .take(FOLLOW_BATCH);
    const legacy = [];
    for (const row of unknown) {
      if (row.approvedAt !== undefined) legacy.push(row);
      else await ctx.db.patch(row._id, { nextSyncAt: NOT_FOLLOWED });
    }
    // Rows with a time have their own budget, so rows from before cannot hold them up.
    const due = await ctx.db
      .query("onboardingPreparations")
      .withIndex("by_settled_and_next_sync", (q) => q.eq("settledAt", undefined).gte("nextSyncAt", 0).lte("nextSyncAt", now))
      .take(FOLLOW_BATCH);
    const ids = [...legacy, ...due].map((row) => row._id);
    for (const id of ids) {
      await ctx.db.patch(id, { nextSyncAt: now + FOLLOW_LEASE_MS });
      await ctx.scheduler.runAfter(0, internal.onboarding.prepare.syncDue, { id });
    }
    return { ids, more: unknown.length === FOLLOW_BATCH || due.length === FOLLOW_BATCH };
  },
});

// After a read, when the next one is due: less often the longer turtl has followed it (convex/prTracking/follow.ts).
export const followNext = internalMutation({
  args: { id: v.id("onboardingPreparations") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row && row.settledAt === undefined && row.approvedAt !== undefined) {
      await ctx.db.patch(id, { nextSyncAt: nextFollowAt(row.requestedAt ?? row.approvedAt, Date.now(), PREPARATION_EVERY_MS) });
    }
    return null;
  },
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
    await ctx.db.patch(id, { blocked: reason, approvedAt: undefined, inspectionId: undefined, requestId: undefined, repo: undefined, baseBranch: undefined, nextSyncAt: NOT_FOLLOWED });
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
      registration: { status: "checking", checks: [], startedAt: now, ...(ref && { ref }) },
    });
    await ctx.scheduler.runAfter(0, internal.onboarding.prepare.register, { preparationId: id, startedAt: now });
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

/**
 * Whether a registration that was started at `startedAt` is still the one the project is waiting for. A registration
 * calls every endpoint of turtl.json on the live app and can take minutes; the owner can tap Check again meanwhile. The
 * one that ends after a newer one was started holds the older list of checks, so it writes nothing: applied, it would
 * bring back a check the newer list retired, and retire one it added. A run with no start named (an operator's, from
 * the command line) is always current.
 */
const current = (registration: Doc<"onboardingPreparations">["registration"], startedAt: number | undefined) =>
  startedAt === undefined || registration?.startedAt === undefined || registration.startedAt === startedAt;

/** What a registration's record keeps from the one before: when the owner last asked, and which request is current. */
const kept = (registration: Doc<"onboardingPreparations">["registration"]) => ({
  ...(registration?.requestedAt !== undefined && { requestedAt: registration.requestedAt }),
  ...(registration?.startedAt !== undefined && { startedAt: registration.startedAt }),
});

export const failRegistration = internalMutation({
  args: { id: v.id("onboardingPreparations"), ref: v.optional(v.string()), error: v.string(), startedAt: v.optional(v.number()) },
  handler: async (ctx, { id, ref, error, startedAt }) => {
    const registration = (await ctx.db.get(id))?.registration;
    // A newer registration was started since this one: its outcome stands, and this failure is not the project's.
    if (!current(registration, startedAt)) return;
    await ctx.db.patch(id, { registration: { status: "failed", error, checks: [], checkedAt: Date.now(), ...(ref && { ref }), ...kept(registration) } });
  },
});

/** More journeys than one project registers; it bounds the lookup by name. */
const JOURNEY_SCAN = 100;
/** The most retired checks kept for one project; registration removes the ones retired longest ago beyond it. */
export const MAX_RETIRED = 25;

const vJourneyEntry = v.object({ name: v.string(), description: v.string(), check: vCheck, checkVersion: v.string(), probe: v.optional(vProbe) });
const vActionEntry = v.object({
  type: v.string(),
  name: v.string(),
  description: v.string(),
  config: vActionConfig,
  parameterConstraints: v.array(vParameterConstraint),
});

type Entry = Omit<Doc<"journeys">, "_id" | "_creationTime" | "appId">;

/**
 * Whether registration wrote this check from the project's turtl.json, and so may retire it: its version is the
 * manifest's, and it is not a prevention check. Every other row is out of registration's reach: a prevention check
 * (convex/structural/checks.ts), a practice project's check (convex/practice), the demo's booking journey
 * (convex/protectedApp/registry.ts), a dev fixture.
 */
export const fromManifest = (journey: Pick<Doc<"journeys">, "checkVersion"> & Partial<Pick<Doc<"journeys">, "preventionFindingId">>) =>
  journey.checkVersion.startsWith(`${MANIFEST_CHECK_VERSION}:`) && journey.preventionFindingId === undefined;

/** Whether two checks are sent the same way to the same place: then one is the other, and its version stands. */
function sameCheck(a: Pick<Doc<"journeys">, "check" | "probe">, b: Pick<Entry, "check" | "probe">) {
  if (a.check.kind !== "http" || b.check.kind !== "http") return false;
  const [x, y] = [a.check.config, b.check.config];
  return x.url === y.url && x.method === y.method && x.expectedStatus === y.expectedStatus && x.credentialRef === y.credentialRef && a.probe === b.probe;
}

/** The project's retired checks, the one retired longest ago first. */
const retiredChecks = (ctx: MutationCtx, appId: Id<"apps">, limit: number) =>
  ctx.db.query("journeys").withIndex("by_app_and_retired", (q) => q.eq("appId", appId).gt("retiredAt", 0)).take(limit);

/** The row of that name that registration owns, among those given. A row it does not own is never matched. */
const owned = (rows: Doc<"journeys">[], name: string) => rows.find((journey) => journey.name === name && fromManifest(journey));

/**
 * Writes one check that answered: onto the row of that name that registration owns and turtl still runs, else onto a
 * retired row of that name that registration owns, which revives it with its history, else as a new row. A row
 * registration does not own is never written over, whatever its name: an entry named like a prevention check gets a
 * row of its own. A check keeps its version while it is sent the same way to the same place, so reading turtl.json at a
 * newer commit changes no version by itself.
 *
 * What a row carries over is its own history only. A check that turns from a probe into a journey check, or back,
 * under the same name starts again: a health check's 200s are not a journey check's passes, and would otherwise make it
 * a check that "has passed before" and that had been "passing" for days. And a revived check's run of passes starts
 * when the monitor next sees it pass, not from a pass a case recorded while it was retired.
 */
async function upsertJourney(ctx: MutationCtx, appId: Id<"apps">, entry: Entry, live: Doc<"journeys">[], retired: Doc<"journeys">[]) {
  const existing = owned(live, entry.name) ?? owned(retired, entry.name);
  if (existing) {
    const otherKind = (probeOf(existing) === null) !== (entry.probe === undefined);
    await ctx.db.patch(existing._id, {
      ...entry,
      // Named, so a check that was a probe and is now a journey check loses the word.
      probe: entry.probe,
      ...(sameCheck(existing, entry) && { checkVersion: existing.checkVersion }),
      ...(otherKind && { lastPassedAt: entry.lastPassedAt, passingSince: undefined, unanswered: undefined }),
      ...(existing.retiredAt !== undefined && { passingSince: undefined, unanswered: undefined }),
      retiredAt: undefined,
    });
  }
  const id = existing?._id ?? (await ctx.db.insert("journeys", { appId, ...entry }));
  // A row written in this registration is one turtl runs from now on: a second entry of the same name lands on it too.
  if (!live.some((journey) => journey._id === id)) {
    const written = await ctx.db.get(id);
    if (written) live.push(written);
  }
  return id;
}

function quoted(names: string[]): string {
  const shown = names.slice(0, 3).map((name) => `"${name}"`);
  if (names.length > 3) return `${shown.join(", ")} and ${names.length - 3} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

// Registers the checks and switches that answered on the live app, and stores every check's result. A check
// that does not answer now is never registered; one registered by an earlier check stays, and says so.
//
// Then it retires what the file no longer lists. `checks` holds every entry of turtl.json, answered or not, so a
// health, readiness or journey check of this project that registration owns (fromManifest) and that no entry names is
// retired: stamped retiredAt, its counts cleared, the row kept because cases and verifications point at it. From then
// on the monitor does not send it, the project does not show it, and it counts for nothing (watching.ts, liveChecks).
// A check listed again is revived on its own row. The note says what was retired, and the project is made due at the
// monitor's next tick, whose round settles an open not-answering case from the checks that are left. A registration
// that failed never reaches here, so it retires nothing; nor does one that ends after a newer one was started.
export const register = internalMutation({
  args: {
    id: v.id("onboardingPreparations"),
    ref: v.string(),
    note: v.optional(v.string()),
    // Which request this registration answers (the merge, or a Check again); none for an operator's run.
    startedAt: v.optional(v.number()),
    checks: v.array(
      v.object({
        result: vLiveCheck,
        journey: v.optional(vJourneyEntry),
        action: v.optional(vActionEntry),
        passedAt: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { id, ref, note, startedAt, checks }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Preparation not found.");
    // A newer registration was started since this one read turtl.json: this list is the older one, and writes nothing.
    if (!current(row.registration, startedAt)) return;
    const live = await liveChecks(ctx, row.appId, JOURNEY_SCAN);
    const retired = await retiredChecks(ctx, row.appId, MAX_RETIRED + JOURNEY_SCAN);
    const results = [];
    for (const { result, journey, action, passedAt } of checks) {
      if (journey) {
        const journeyId = await upsertJourney(ctx, row.appId, { ...journey, ...(passedAt !== undefined && { lastPassedAt: passedAt }) }, live, retired);
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
        // A check turtl still runs under that name stays, though it did not answer just now. A retired one stays retired.
        const earlier = owned(live, result.name);
        results.push(earlier ? { ...result, journeyId: earlier._id, detail: `${result.detail} It stays registered from an earlier check.` } : result);
      }
    }
    // Retire what the file no longer lists, among the rows registration owns.
    const now = Date.now();
    const listed = new Set(checks.filter(({ result }) => result.kind === "health" || result.kind === "readiness" || result.kind === "journey").map(({ result }) => result.name));
    const gone = live.filter((journey) => fromManifest(journey) && journey.retiredAt === undefined && !listed.has(journey.name));
    for (const journey of gone) await ctx.db.patch(journey._id, { retiredAt: now, unanswered: undefined, passingSince: undefined });
    // Keep the project's retired rows bounded: the ones retired longest ago go.
    const all = await retiredChecks(ctx, row.appId, MAX_RETIRED + JOURNEY_SCAN);
    for (const journey of all.slice(0, Math.max(0, all.length - MAX_RETIRED))) await ctx.db.delete(journey._id);
    const retiredNote = gone.length ? `turtl stopped checking ${quoted(gone.map((journey) => journey.name))}: ${MANIFEST_FILE} no longer lists ${gone.length === 1 ? "it" : "them"}.` : undefined;
    const notes = [note, retiredNote].filter((one): one is string => Boolean(one)).join(" ");
    await ctx.db.patch(id, {
      registration: { status: "done", ref, checks: results, checkedAt: now, ...(notes && { note: notes }), ...kept(row.registration) },
    });
    // What answered is watched from the monitor's next tick (convex/protectedApp/watching.ts).
    await checkSoon(ctx, row.appId);
  },
});
