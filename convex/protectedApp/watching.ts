import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { projectSecret } from "../secrets/store";
import { liveAddressProblem } from "./address";

// Which projects the monitor checks with accounts on (AUTH_REQUIRED=true), and when. The single-owner demo does not use
// this file: its monitor checks the one demo app named by PROTECTED_APP_URL, as before.
//
// Only a project that has checks has a row (watchedProjects), and each row says when the project is next due. Each tick
// claims the due rows through the by_next_check index, oldest first, CLAIM_BATCH at a time, so a project is checked on
// its own schedule however many other projects exist (second review, finding 15: before, every project took a turn in
// creation order, empty ones too). A project that can be checked gets its own action (monitor:checkProject), so one slow
// app never holds up another, and every check's time is bounded (protectedApp/client.ts). A project that keeps failing
// the same way is checked less often, down to once every FAILING_FLOOR_MS, and is back to every minute when it passes or
// its owner taps Check again. A project that cannot be checked (its owner deleted their account, it has no usable live
// address, or its checks need a control token it does not have) is not checked at all: its reason is recorded once,
// shown to its owner, and read again every SKIPPED_EVERY_MS, with nothing sent.

/** How often a project that passes, or has just started failing, is checked. */
export const CHECK_EVERY_MS = 60_000;
/** Taken off each next-check time, so a check finishing a moment after its tick is due again at the next one. */
const TICK_SLACK_MS = 10_000;
/** How long a project failing the same way waits before its next check, by how many checks in a row failed so. */
export const FAILING_STEPS_MS = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];
/** The longest a project that keeps failing the same way waits between checks. */
export const FAILING_FLOOR_MS = FAILING_STEPS_MS[FAILING_STEPS_MS.length - 1];
/** How often the monitor reads again why it cannot check a project. Setting a control token makes it due at once. */
export const SKIPPED_EVERY_MS = 10 * 60_000;
/** How often a row whose project no longer has checks is read again. */
const NO_CHECKS_EVERY_MS = 24 * 60 * 60_000;
/** Due projects one claim takes; the tick claims again while a claim comes back full (monitor.ts). */
export const CLAIM_BATCH = 100;
/** Checks one claim looks at for a project that has no row yet (a project registers up to MAX_JOURNEYS). */
const DISCOVER_BATCH = 200;
/** More checks than a turtl.json registers (MAX_MANIFEST_ENTRIES per list, plus health and readiness). */
export const MAX_JOURNEYS = 25;
/** A check still running after this long is taken to have stopped, and the project gets its turn again. */
export const LEASE_MS = 5 * 60_000;

/** How long after a check began the next one is due: every minute, or longer while it keeps failing the same way. */
export function intervalAfter(streak: number): number {
  return streak <= 1 ? CHECK_EVERY_MS : FAILING_STEPS_MS[Math.min(streak, FAILING_STEPS_MS.length) - 1];
}

export const WATCH_WORDS = {
  noOwner: "turtl does not know whose project this is, so it does not watch it.",
  ownerGone: "Its owner deleted their account, so turtl no longer watches it.",
  noAddress: "It has no live address, so turtl has nothing to check.",
  noToken: "No control token is set, so turtl cannot run this project's checks. Add it in this project's Settings, under Control token.",
  someNeedToken: "Some of this project's checks need the control token, so turtl runs only the others until you add it in this project's Settings, under Control token.",
  noChecks: "It has no checks turtl can run, so turtl has nothing to check.",
  // The single-owner demo with its checks switched off (PROTECTED_APP_URL unset, convex/monitor.ts).
  checksOff: "turtl's checks are turned off for now, so turtl has nothing to check.",
};

type Read = Pick<QueryCtx, "db">;
type Http = Extract<Doc<"journeys">["check"], { kind: "http" }>;
/** countable: the check can stop answering (canStopAnswering), so its tries with no answer count. */
export type Runnable = { journeyId: Id<"journeys">; url: string; credentialRef?: string; countable: boolean };

/**
 * Whether a check can stop answering (convex/protectedApp/notAnswering.ts): only one that has answered before. That is
 * a journey-contract check, the only kind the monitor runs (it POSTs every check as a journey check), that has passed at
 * least once. A project's health and readiness endpoints are registered as journeys beside its real checks, as GET
 * checks, passed at registration from their 200 (convex/onboarding/prepare.ts, checkLive); they never return a check
 * result to the monitor, so they never count. Nor does a check that has never passed, such as one at a wrong address.
 */
export const canStopAnswering = (journey: Pick<Doc<"journeys">, "check" | "lastPassedAt">) =>
  journey.check?.kind === "http" && journey.check.config.method === "POST" && journey.lastPassedAt !== undefined;
/**
 * unanswered: some check of the project has quiet tries on record; caseOpen: the project records an open not-answering
 * case (apps.notAnsweringCase). Either one means the end of a round has something to settle (notAnswering.ts).
 */
type Plan = { unanswered: boolean; caseOpen: boolean } & ({ kind: "none" } | { kind: "skip"; reason: string } | { kind: "run"; base: string; journeys: Runnable[]; partial: string | null });

/** What the monitor can check for one project now, read from its own rows. */
export async function planFor(ctx: Read, app: Doc<"apps">): Promise<Plan> {
  const caseOpen = app.notAnsweringCase !== undefined;
  if (app.isSample) return { kind: "none", unanswered: false, caseOpen };
  const rows = await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", app._id)).take(MAX_JOURNEYS);
  const unanswered = rows.some((journey) => journey.unanswered !== undefined);
  const journeys = rows.flatMap((journey) => (journey.check.kind === "http" ? [{ journeyId: journey._id, ...pick(journey.check), countable: canStopAnswering(journey) }] : []));
  if (journeys.length === 0) return { kind: "none", unanswered, caseOpen };
  const skip = (reason: string): Plan => ({ kind: "skip", reason, unanswered, caseOpen });
  if (!app.ownerId) return skip(WATCH_WORDS.noOwner);
  const owner = ctx.db.normalizeId("users", app.ownerId);
  if (!owner || !(await ctx.db.get(owner))) return skip(WATCH_WORDS.ownerGone);
  if (!app.productionUrl) return skip(WATCH_WORDS.noAddress);
  const problem = liveAddressProblem(app.productionUrl, undefined, app.practice ? app._id : undefined);
  if (problem) return skip(problem);
  const hasToken = (await projectSecret(ctx, app._id, "control_token")) !== null;
  const runnable = journeys.filter((journey) => hasToken || !journey.credentialRef);
  if (runnable.length === 0) return skip(WATCH_WORDS.noToken);
  return { kind: "run", base: app.productionUrl.replace(/\/+$/, ""), journeys: runnable, partial: runnable.length < journeys.length ? WATCH_WORDS.someNeedToken : null, unanswered, caseOpen };
}

const pick = (check: Http): Omit<Runnable, "journeyId" | "countable"> => ({ url: check.config.url, ...(check.config.credentialRef && { credentialRef: check.config.credentialRef }) });

const stateOf = (ctx: Read, appId: Id<"apps">) => ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).first();

async function writeState(ctx: Pick<MutationCtx, "db">, appId: Id<"apps">, row: Doc<"watchedProjects"> | null, fields: Partial<Omit<Doc<"watchedProjects">, "_id" | "_creationTime" | "appId">>) {
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("watchedProjects", { appId, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });
}

const sameNotice = (row: Doc<"watchedProjects"> | null, reason: string | null) => (row?.notice?.reason ?? null) === reason;

/** Why the monitor is not checking a project, or checks only some of it, for its owner to read. Null when all is checked. */
export async function watchNotice(ctx: Read, appId: Id<"apps">): Promise<string | null> {
  return (await stateOf(ctx, appId))?.notice?.reason ?? null;
}

// A project whose checks were added without a row (before rows were kept, by a path that makes none, or new checks on a
// project waiting for its next turn) gets one, due now. Reads the checks added since it last looked, a batch at a time,
// and says whether the batch was full, so the tick claims again.
async function discover(ctx: Pick<MutationCtx, "db">, now: number): Promise<boolean> {
  const cursor = await ctx.db.query("monitorCursor").first();
  const journeys = await ctx.db
    .query("journeys")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor?.journeysAfter ?? 0))
    .take(DISCOVER_BATCH);
  if (!journeys.length) return false;
  for (const appId of new Set(journeys.map((journey) => journey.appId))) {
    const row = await stateOf(ctx, appId);
    if (!row) await ctx.db.insert("watchedProjects", { appId });
    else if (row.nextCheckAt !== undefined && row.nextCheckAt > now) await ctx.db.patch(row._id, { nextCheckAt: now });
  }
  const journeysAfter = journeys[journeys.length - 1]._creationTime;
  if (cursor) await ctx.db.patch(cursor._id, { journeysAfter, at: now });
  else await ctx.db.insert("monitorCursor", { after: 0, at: now, journeysAfter });
  return journeys.length === DISCOVER_BATCH;
}

// One claim: finds projects whose checks are new, then takes the due projects, oldest due first, records why any
// cannot be checked, and starts a check for each that can. `more`: the claim was full, so the tick claims again.
export const claim = internalMutation({
  args: {},
  returns: v.object({ started: v.array(v.id("apps")), skipped: v.array(v.object({ appId: v.id("apps"), reason: v.string() })), more: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const found = await discover(ctx, now);
    // Rows from before next-check times were kept are due now; then the rest whose time has come. (Convex sorts a
    // missing value first, so the second read may return the first's rows again; each is taken once.)
    const legacy = await ctx.db.query("watchedProjects").withIndex("by_next_check", (q) => q.eq("nextCheckAt", undefined)).take(CLAIM_BATCH);
    const taken = new Set(legacy.map((row) => row._id));
    const due =
      legacy.length < CLAIM_BATCH
        ? (await ctx.db.query("watchedProjects").withIndex("by_next_check", (q) => q.lte("nextCheckAt", now)).take(CLAIM_BATCH))
            .filter((row) => row.nextCheckAt !== undefined && !taken.has(row._id))
            .slice(0, CLAIM_BATCH - legacy.length)
        : [];
    const started: Id<"apps">[] = [];
    const skipped: { appId: Id<"apps">; reason: string }[] = [];
    for (const row of [...legacy, ...due]) {
      const app = await ctx.db.get(row.appId);
      if (!app) {
        await ctx.db.delete(row._id);
        continue;
      }
      const turn = await takeTurn(ctx, app, now, row);
      if (turn.kind === "started") started.push(app._id);
      if (turn.kind === "skipped") skipped.push({ appId: app._id, reason: turn.reason });
    }
    return { started, skipped, more: found || legacy.length + due.length === CLAIM_BATCH };
  },
});

/**
 * One project's turn: records why it cannot be checked, or starts its check (monitor:checkProject) unless one is
 * already running, and says when the project is next due. The tick gives each due project its turn; a practice app's
 * owner who has just made or broken it gets that project's turn at once (convex/practice/projects.ts), through the
 * same lease.
 */
export async function takeTurn(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  app: Doc<"apps">,
  now: number,
  known?: Doc<"watchedProjects">,
): Promise<{ kind: "none" } | { kind: "skipped"; reason: string } | { kind: "running" } | { kind: "started" }> {
  const plan = await planFor(ctx, app);
  const row = known ?? (await stateOf(ctx, app._id));
  // turtl stops checking a project whose checks have quiet tries on record, or that records an open not-answering case:
  // the counts go, and the case closes with why (convex/protectedApp/notAnswering.ts). Only then is anything more read.
  const stop = (reason: string) => ctx.scheduler.runAfter(0, internal.protectedApp.notAnswering.stopped, { appId: app._id, reason });
  if (plan.kind === "none") {
    // Nothing to check: no row is made, and one left from earlier checks is read again only now and then.
    if (row) await ctx.db.patch(row._id, { nextCheckAt: now + NO_CHECKS_EVERY_MS });
    if (plan.unanswered || plan.caseOpen) await stop(WATCH_WORDS.noChecks);
    return { kind: "none" };
  }
  if (plan.kind === "skip") {
    await writeState(ctx, app._id, row, {
      nextCheckAt: now + SKIPPED_EVERY_MS,
      ...(!sameNotice(row, plan.reason) && { notice: { reason: plan.reason, at: now, partial: false } }),
    });
    if (plan.unanswered || plan.caseOpen) await stop(plan.reason);
    return { kind: "skipped", reason: plan.reason };
  }
  if (row?.runningSince !== undefined && now - row.runningSince < LEASE_MS) {
    // Its check is still running: it is due again when that check's lease runs out, unless the check finishes first.
    if (row.nextCheckAt !== row.runningSince + LEASE_MS) await ctx.db.patch(row._id, { nextCheckAt: row.runningSince + LEASE_MS });
    return { kind: "running" };
  }
  await writeState(ctx, app._id, row, {
    runningSince: now,
    nextCheckAt: now + LEASE_MS,
    ...(!sameNotice(row, plan.partial) && { notice: plan.partial ? { reason: plan.partial, at: now, partial: true } : undefined }),
  });
  await ctx.scheduler.runAfter(0, internal.monitor.checkProject, { appId: app._id });
  return { kind: "started" };
}

/**
 * Makes a project with checks due at the next tick, at the ordinary pace: its checks were just registered, its owner
 * tapped Check again, or set the control token its checks were waiting for. A project without checks gets no row.
 * Nothing in the single-owner demo.
 */
export async function checkSoon(ctx: Pick<MutationCtx, "db">, appId: Id<"apps">) {
  if (!accessEnforced()) return;
  const row = await stateOf(ctx, appId);
  if (row) {
    await ctx.db.patch(row._id, { nextCheckAt: Math.min(row.nextCheckAt ?? 0, Date.now()), failure: undefined });
    return;
  }
  if (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).first()) await ctx.db.insert("watchedProjects", { appId });
}

export const watchSoon = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.null(),
  handler: async (ctx, { appId }) => {
    await checkSoon(ctx, appId);
    return null;
  },
});

// What one project's check runs now: its live address and the checks it can run, whether any of its checks has quiet
// tries on record, whether it records an open not-answering case, and whether it is a practice project, for the end of
// the round (monitor.ts). Null when it cannot be checked.
export const plan = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.union(
    v.null(),
    v.object({
      base: v.string(),
      journeys: v.array(v.object({ journeyId: v.id("journeys"), url: v.string(), credentialRef: v.optional(v.string()), countable: v.boolean() })),
      unanswered: v.boolean(),
      caseOpen: v.boolean(),
      practice: v.boolean(),
    }),
  ),
  handler: async (ctx, { appId }) => {
    const app = await ctx.db.get(appId);
    const found = app ? await planFor(ctx, app) : null;
    return found?.kind === "run" ? { base: found.base, journeys: found.journeys, unanswered: found.unanswered, caseOpen: found.caseOpen, practice: app?.practice === true } : null;
  },
});

// A check hands its turn back and says how it went. failure: what every check of the project failed with, when none
// passed (monitor.ts, failureOf); null when one passed; left out when nothing ran. The same failure as last time
// spaces the next check out (intervalAfter); a pass, or anything new, puts it back to every minute. answered: a check
// of the round got a usable reply (a pass or a failure), recorded as lastAnsweredAt in the same write.
export const finish = internalMutation({
  args: { appId: v.id("apps"), checkedAt: v.number(), failure: v.optional(v.union(v.string(), v.null())), answered: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { appId, checkedAt, failure, answered }) => {
    const row = await stateOf(ctx, appId);
    if (!row) return null;
    const same = failure && row.failure?.signature === failure;
    const next = failure ? { signature: failure, streak: same ? row.failure!.streak + 1 : 1, since: same ? row.failure!.since : checkedAt } : undefined;
    const began = row.runningSince ?? checkedAt;
    await ctx.db.patch(row._id, {
      runningSince: undefined,
      lastCheckedAt: checkedAt,
      ...(answered && { lastAnsweredAt: checkedAt }),
      failure: next,
      nextCheckAt: Math.max(checkedAt, began + intervalAfter(next?.streak ?? 0) - TICK_SLACK_MS),
    });
    return null;
  },
});

// Eraser for deleting a project (convex/account/): its monitor state.
export const forgetProject = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, { appId }) => {
    const rows = await ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).take(10);
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});
