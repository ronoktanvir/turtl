import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { accessEnforced, MAX_PROJECTS } from "./access";

const CLOSED_DEMO_SKIPPED = "This deployment holds accounts but runs as the single-owner demo, so the monitor checked nothing (the backend log says why).";
import { CLOSED_CASE_STATUSES } from "./constants";
import { controlBase, readErrors, runJourneyCheck, runProbe, type JourneyOutcome, type Probe, type WatchedApp } from "./protectedApp/client";
import { gotThrough, isQuiet, passedOutsideRound, PRACTICE_QUIET, settleRound, type Try } from "./protectedApp/notAnswering";
import { watchedApp } from "./protectedApp/watched";
import { liveChecks, runnable, WATCH_WORDS, type Runnable } from "./protectedApp/watching";
import { startCaseRun } from "./runner/run";

// The monitor. In the single-owner demo it checks every registered journey of the one demo app named by
// PROTECTED_APP_URL, with the deployment's control secret, as before. With accounts on (AUTH_REQUIRED=true) it needs no
// PROTECTED_APP_URL: each tick takes the next projects in turn (convex/protectedApp/watching.ts) and checks each one's
// journeys from its own rows, with its own control token, only on its own live address.
//
// Each check is sent as what it is. A journey check is a POST under the journey contract: one that runs and fails
// opens a case (openCase). A health or readiness check is a GET (checkProbe): a pass moves when it last passed, and
// nothing it returns opens an ordinary case. A check that gets no usable reply is counted, and a project whose checks
// stop answering gets one case of its own (convex/protectedApp/notAnswering.ts), settled at the end of each round that
// has anything to settle. A check registration retired is never read here (watching.ts, liveChecks).

// A case stops counting as open once it is closed or its service is restored.
const NOT_OPEN: readonly string[] = [...CLOSED_CASE_STATUSES, "restored"];

export const signatureFor = (journeyId: Id<"journeys">) => `journey_failed:${journeyId}`;

// The single-owner demo's journeys, project by project. Bounded like everything else: at most MAX_PROJECTS projects
// and MAX_JOURNEYS journeys each, the ones turtl still runs, never the whole table in one go. With accounts on the
// monitor never calls it (protectedApp/watching.ts takes projects in turns instead).
export const journeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db.query("apps").take(MAX_PROJECTS);
    const rows = [];
    for (const app of apps) {
      for (const journey of await liveChecks(ctx, app._id)) rows.push({ journey, app });
    }
    return rows;
  },
});

const vCounts = v.object({
  totalBookings: v.number(),
  failedBookings: v.number(),
  errorRate: v.number(),
});

function describeImpact(
  failedStep: string,
  counts: { totalBookings: number; failedBookings: number; errorRate: number } | null,
  countsReason: string | null,
  practice = false,
) {
  const check = `The booking check fails at the "${failedStep.replace(/_/g, " ")}" step, so a booking cannot be completed.`;
  // A practice app (convex/practice) has no customers: only turtl's test booking ever fails on it.
  if (practice) return { title: "Booking is failing", impact: `${check} This is your practice app, which has no customers, so only turtl's test booking failed.` };
  if (!counts) {
    return {
      title: "Customers may not be able to book",
      impact: `${check} Failed booking counts could not be read (${countsReason ?? "unknown reason"}).`,
    };
  }
  if (counts.failedBookings === 0) {
    return {
      title: "Booking is failing",
      impact: `${check} No customer booking has failed in the last 15 minutes (${counts.totalBookings} attempted), but the next customer is likely to hit it.`,
    };
  }
  return {
    title: `Customers can't book: ${counts.failedBookings} of ${counts.totalBookings} bookings failed`,
    impact: `${counts.failedBookings} of ${counts.totalBookings} booking attempts in the last 15 minutes failed (${Math.round(counts.errorRate * 100)}%). ${check}`,
  };
}

// A passing check of the journey, from the monitor or from verify, re-arms its signature, and starts its run of passes
// if it was not passing. `round`: the monitor's own round, whose end settles the check's quiet tries
// (notAnswering.ts); a pass from anywhere else (a case's verify step) clears them here, and closes an open
// not-answering case.
export const recordPass = internalMutation({
  args: { journeyId: v.id("journeys"), observedAt: v.number(), round: v.optional(v.boolean()) },
  handler: async (ctx, { journeyId, observedAt, round }) => {
    const journey = await ctx.db.get(journeyId);
    if (journey && observedAt > (journey.lastPassedAt ?? 0)) {
      // A retired check is not watched, so a pass of it (from a case that still runs it) starts no run of passes.
      await ctx.db.patch(journeyId, { lastPassedAt: observedAt, ...(journey.passingSince === undefined && journey.retiredAt === undefined && { passingSince: observedAt }) });
    }
    // A retired check counts for nothing: its pass, from a case that still runs it, closes no not-answering case.
    if (journey && !round && journey.retiredAt === undefined) await passedOutsideRound(ctx, journey, observedAt);
  },
});

// A check of the journey that got no answer ends its run of passes, as a failure does (openCase).
export const recordMiss = internalMutation({
  args: { journeyId: v.id("journeys") },
  returns: v.null(),
  handler: async (ctx, { journeyId }) => {
    const journey = await ctx.db.get(journeyId);
    if (journey?.passingSince !== undefined) await ctx.db.patch(journeyId, { passingSince: undefined });
    return null;
  },
});

// Opens one case per failure of a journey: nothing while a case with its signature is open, and nothing
// after that case closes until the journey has passed again.
export const openCase = internalMutation({
  args: {
    journeyId: v.id("journeys"),
    failedStep: v.string(),
    observedAt: v.number(),
    counts: v.union(vCounts, v.null()),
    countsReason: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { journeyId, failedStep, observedAt, counts, countsReason }) => {
    const journey = await ctx.db.get(journeyId);
    if (!journey) throw new Error("Journey not found.");
    // Retired while this round was in flight (convex/onboarding/records.ts): the monitor opens no case for it.
    if (journey.retiredAt !== undefined) return { opened: false as const, reason: "this check was retired: the project's turtl.json no longer lists it" };
    if (journey.lastPassedAt !== undefined && observedAt < journey.lastPassedAt) return { opened: false as const, reason: "this observation is older than the journey's latest passing check" };
    // How long it had been passing before this failure, which the failure ends (convex/consent/gate.ts, the reserve).
    const passingForMs = journey.passingSince !== undefined ? Math.max(0, observedAt - journey.passingSince) : 0;
    if (journey.passingSince !== undefined) await ctx.db.patch(journeyId, { passingSince: undefined });
    const signature = signatureFor(journeyId);
    const previous = await ctx.db
      .query("cases")
      .withIndex("by_app_and_signature", (q) => q.eq("appId", journey.appId).eq("signature", signature))
      .order("desc")
      .take(50); // the newest: an open case for a signature is always its latest
    const existing = previous.find((row) => !NOT_OPEN.includes(row.status));
    if (existing) return { opened: false as const, caseId: existing._id, reason: "a case for this failure is open" };
    const last = previous.reduce<(typeof previous)[number] | null>(
      (latest, row) => (!latest || row._creationTime > latest._creationTime ? row : latest),
      null,
    );
    if (last && (journey.lastPassedAt ?? 0) <= last._creationTime) {
      return {
        opened: false as const,
        caseId: last._id,
        reason: `the journey has not passed since the last case for it (${last.status})`,
      };
    }
    const { title, impact } = journey.preventionFindingId
      ? {
          title: `A prevention check failed: ${journey.name}`,
          impact: `${journey.description} It failed at the "${failedStep.replace(/_/g, " ")}" step. ${counts ? `${counts.failedBookings} of ${counts.totalBookings} customer booking attempts failed in the last 15 minutes.` : `Customer booking counts could not be read (${countsReason ?? "unknown reason"}).`}`,
        }
      : describeImpact(failedStep, counts, countsReason, (await ctx.db.get(journey.appId))?.practice === true);
    const caseId = await startCaseRun(ctx, {
      appId: journey.appId,
      journeyId,
      title,
      impact,
      kind: "outage",
      raisedBy: "monitor",
      raisedByRef: `journey check: ${journey.name}`,
      signature,
    });
    await ctx.db.patch(caseId, { passingForMs });
    const app = await ctx.db.get(journey.appId);
    await ctx.scheduler.runAfter(0, internal.notices.notifyOwner, {
      caseId,
      event: "opened",
      text: `Something is wrong with ${app?.name ?? "your app"}: ${title}. turtl is looking into it now.`,
    });
    return { opened: true as const, caseId };
  },
});

type Checked = {
  journeyId: Id<"journeys">;
  outcome: "passed" | "failed" | "check_error";
  detail: string;
  caseId?: Id<"cases">;
  opened?: boolean;
  reason?: string;
};

type Swept = { started: Id<"apps">[]; skipped: { appId: Id<"apps">; reason: string }[] };

export type MonitorResult = { skipped: string } | { checked: Checked[] } | Swept;

/** What a check with no result got, as the end of the round counts it (notAnswering.ts). */
function missed(outcome: Extract<JourneyOutcome, { ok: false }>): Try["got"] {
  if (outcome.kind === "no_response") return { kind: "no_response", timedOut: outcome.timedOut };
  if (outcome.kind === "no_result") return { kind: "no_result", status: outcome.status };
  return { kind: "not_sent" };
}

/**
 * Sends one health or readiness check for one project now, as a GET. A pass moves when it last passed. Anything else
 * ends its run of passes and is counted at the end of the round; a probe carries no verdict, so nothing here opens an
 * ordinary case. A readiness check's "not ready" is reported as a failure of that check, in the app's own words.
 */
async function checkProbe(ctx: ActionCtx, journey: Runnable, probe: Probe, app: WatchedApp): Promise<{ checked: Checked; tried: Try }> {
  const observedAt = Date.now();
  const tried = (got: Try["got"]): Try => ({ journeyId: journey.journeyId, at: observedAt, got });
  const outcome = await runProbe({ url: journey.url, credentialRef: journey.credentialRef, probe }, app);
  if (outcome.kind === "passed") {
    await ctx.runMutation(internal.monitor.recordPass, { journeyId: journey.journeyId, observedAt, round: true });
    return { checked: { journeyId: journey.journeyId, outcome: "passed", detail: probe === "health" ? "The health check answered." : "The app said it is ready to serve customers." }, tried: tried({ kind: "passed" }) };
  }
  await ctx.runMutation(internal.monitor.recordMiss, { journeyId: journey.journeyId });
  if (outcome.kind === "not_ready") {
    return { checked: { journeyId: journey.journeyId, outcome: "failed", detail: "The app said it is not ready to serve customers." }, tried: tried({ kind: "not_ready" }) };
  }
  const got: Try["got"] = outcome.kind === "no_response" ? { kind: "no_response", timedOut: outcome.timedOut } : outcome.kind === "no_result" ? { kind: "no_result", status: outcome.status } : { kind: "not_sent" };
  return { checked: { journeyId: journey.journeyId, outcome: "check_error", detail: outcome.reason }, tried: tried(got) };
}

/**
 * Checks one check for one project (app) now, as what it is: a probe as a GET (checkProbe), a journey check as a POST
 * under the journey contract, where a failure opens a case and a pass re-arms its signature. Also says what the try
 * got, for the end of the round.
 */
async function checkJourney(ctx: ActionCtx, journey: Runnable, base: string, app: WatchedApp): Promise<{ checked: Checked; tried: Try }> {
  if (journey.probe) return await checkProbe(ctx, journey, journey.probe, app);
  const observedAt = Date.now();
  const tried = (got: Try["got"]): Try => ({ journeyId: journey.journeyId, at: observedAt, got });
  const outcome = await runJourneyCheck(journey, app);
  if (!outcome.ok) {
    await ctx.runMutation(internal.monitor.recordMiss, { journeyId: journey.journeyId });
    return { checked: { journeyId: journey.journeyId, outcome: "check_error", detail: outcome.reason }, tried: tried(missed(outcome)) };
  }
  const { result } = outcome;
  if (result.verdict === "passed") {
    await ctx.runMutation(internal.monitor.recordPass, { journeyId: journey.journeyId, observedAt, round: true });
    return { checked: { journeyId: journey.journeyId, outcome: "passed", detail: "The booking check passed." }, tried: tried({ kind: "passed" }) };
  }
  const errors = await readErrors(base, app);
  const opened = await ctx.runMutation(internal.monitor.openCase, {
    journeyId: journey.journeyId,
    failedStep: result.failedStep ?? "unknown",
    observedAt,
    counts: errors.ok
      ? {
          totalBookings: errors.body.counts.totalBookings,
          failedBookings: errors.body.counts.failedBookings,
          errorRate: errors.body.counts.errorRate,
        }
      : null,
    countsReason: errors.ok ? null : errors.reason,
  });
  return {
    checked: {
      journeyId: journey.journeyId,
      outcome: "failed",
      detail: `The booking check failed at "${result.failedStep}" (${result.error?.code ?? "no error code"}).`,
      ...opened,
    },
    tried: tried({ kind: "failed" }),
  };
}

/**
 * Whether the end of a round has anything to settle (notAnswering.ts): the project records an open not-answering case,
 * a check of it has quiet tries on record, or a check that can stop answering (watching.ts, canStopAnswering) was quiet
 * this round. Otherwise nothing is read or written: a passing check, or a check that has never passed getting no
 * answer, settles nothing on its own. When it settles, every try the round sent goes with it, and the end of the round
 * works out which of them decide (notAnswering.ts, settle).
 */
const toSettle = (caseOpen: boolean, unanswered: boolean, journeys: Runnable[], tries: Try[]) => {
  const can = new Set<string>(journeys.filter((journey) => journey.countable).map((journey) => journey.journeyId));
  return caseOpen || unanswered || tries.some((tried) => can.has(tried.journeyId) && isQuiet(tried.got));
};

// The single-owner demo's monitor, as before: every journey, one after another. Its project's not-answering case
// follows the same rules as with accounts on, each project's checks being one round.
export async function checkJourneys(ctx: ActionCtx): Promise<MonitorResult> {
  if (!controlBase()) {
    // Nothing is checked, so a project whose checks have counts is no longer watched: its counts go, and an open
    // not-answering case closes with why. This reads what a tick with PROTECTED_APP_URL set reads, and no more.
    const rows = await ctx.runQuery(internal.monitor.journeys, {});
    for (const appId of new Set(rows.filter(({ journey, app }) => journey.unanswered !== undefined || app.notAnsweringCase !== undefined).map(({ app }) => app._id))) {
      await ctx.runMutation(internal.protectedApp.notAnswering.stopped, { appId, reason: WATCH_WORDS.checksOff });
    }
    return { skipped: "PROTECTED_APP_URL is not set on this deployment, so no journey was checked." };
  }
  const rows = await ctx.runQuery(internal.monitor.journeys, {});
  const projects = new Map<Id<"apps">, typeof rows>();
  for (const row of rows) projects.set(row.app._id, [...(projects.get(row.app._id) ?? []), row]);
  const checked: Checked[] = [];
  for (const [appId, group] of projects) {
    const app = group[0].app;
    const unanswered = group.some(({ journey }) => journey.unanswered !== undefined);
    const caseOpen = app.notAnsweringCase !== undefined;
    const sendable: Runnable[] = group.flatMap(({ journey }) => (journey.check.kind === "http" ? [runnable(journey, journey.check)] : []));
    if (!app.productionUrl || sendable.length === 0) {
      // Not checked: its checks' counts go, and an open case closes with why.
      if (unanswered || caseOpen) await ctx.runMutation(internal.protectedApp.notAnswering.stopped, { appId, reason: app.productionUrl ? WATCH_WORDS.noChecks : WATCH_WORDS.noAddress });
      continue;
    }
    const watched = await watchedApp(ctx, { appId });
    const tries: Try[] = [];
    for (const journey of sendable) {
      const one = await checkJourney(ctx, journey, app.productionUrl, watched);
      checked.push(one.checked);
      tries.push(one.tried);
    }
    if (toSettle(caseOpen, unanswered, sendable, tries)) await settleRound(ctx, appId, tries);
  }
  return { checked };
}

/** At most this many of one project's checks run at once. */
const CONCURRENT_CHECKS = 5;

// With accounts on: one project's checks, read from its own rows. watching:claim starts it; it always hands its turn back.
const vChecked = v.object({
  journeyId: v.id("journeys"),
  outcome: v.union(v.literal("passed"), v.literal("failed"), v.literal("check_error")),
  detail: v.string(),
  caseId: v.optional(v.id("cases")),
  opened: v.optional(v.boolean()),
  reason: v.optional(v.string()),
});

/**
 * What every check of a project failed with, when none passed: one short signature, the same each time the project
 * fails the same way (watching.ts spaces its checks out then). Null when a check passed or none ran. Given the checks
 * that decide for the project (deciding, below).
 */
export function failureOf(checked: Checked[]): string | null {
  if (!checked.length || checked.some((check) => check.outcome === "passed")) return null;
  const text = checked.map((check) => `${check.journeyId} ${check.outcome} ${check.detail}`).sort().join("\n");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${checked.length}:${hash.toString(16)}`;
}

/**
 * The checks of a round whose results say how the project is doing, for how often it is checked: its journey checks,
 * and its probes too when they decide (watching.ts, probesDecide). So a health check that passes beside a journey
 * check that keeps failing the same way does not put the project back to every minute. When a round ran only probes
 * (its journey checks wait for a control token), they are all there is to go by.
 */
export function deciding(checked: Checked[], journeys: Runnable[], probesDecide: boolean): Checked[] {
  if (probesDecide) return checked;
  const probes = new Set<string>(journeys.filter((journey) => journey.probe).map((journey) => journey.journeyId));
  const rest = checked.filter((one) => !probes.has(one.journeyId));
  return rest.length ? rest : checked;
}

export const checkProject = internalAction({
  args: { appId: v.id("apps") },
  returns: v.object({ checked: v.array(vChecked) }),
  handler: async (ctx, { appId }): Promise<{ checked: Checked[] }> => {
    let failure: string | null | undefined;
    let answered = false;
    try {
      const plan: { base: string; journeys: Runnable[]; probesDecide: boolean; unanswered: boolean; caseOpen: boolean; practice: boolean } | null = await ctx.runQuery(internal.protectedApp.watching.plan, { appId });
      if (!plan) return { checked: [] };
      const app = await watchedApp(ctx, { appId });
      const checked: Checked[] = [];
      const tries: Try[] = [];
      for (let start = 0; start < plan.journeys.length; start += CONCURRENT_CHECKS) {
        const turn = plan.journeys.slice(start, start + CONCURRENT_CHECKS);
        for (const one of await Promise.all(turn.map((journey) => checkJourney(ctx, journey, plan.base, app)))) {
          checked.push(one.checked);
          tries.push(one.tried);
        }
      }
      failure = failureOf(deciding(checked, plan.journeys, plan.probesDecide));
      // Recorded for the fleet check (notAnswering.ts, fleetQuiet): a check of this round reached something that replied,
      // so turtl's requests get out. Never for a practice project, which runs on turtl's own site and so is no evidence
      // about turtl reaching the internet.
      answered = !plan.practice && tries.some((tried) => gotThrough(tried.got));
      // A practice project's app is turtl's own: a check of it that is quiet is turtl's trouble, for the operator's log,
      // once a round. Its tries count for nothing (only a count or case left from before is settled away).
      const evidence = plan.practice ? [] : tries;
      if (plan.practice && tries.some((tried) => isQuiet(tried.got))) console.warn(PRACTICE_QUIET);
      if (toSettle(plan.caseOpen, plan.unanswered, plan.journeys, evidence)) await settleRound(ctx, appId, evidence);
      return { checked };
    } finally {
      await ctx.runMutation(internal.protectedApp.watching.finish, { appId, checkedAt: Date.now(), ...(failure !== undefined && { failure }), ...(answered && { answered }) });
    }
  },
});

/** Claims one tick makes at most: CLAIM_BATCH due projects each, so up to 2,000 projects start their checks a minute. */
const MAX_CLAIMS_PER_TICK = 20;

// Run by convex/crons.ts. The demo checks its one app; with accounts on, every due project gets its check, claimed a
// batch at a time until a claim comes back short.
export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<MonitorResult> => {
    if (!accessEnforced()) {
      // A deployment that holds accounts and lost AUTH_REQUIRED is not the demo: it checks nothing, so it opens no case
      // and sends no request, and the backend log says why once (convex/access.ts, noteClosedDemo).
      const { closed }: { closed: boolean } = await ctx.runMutation(internal.access.noteClosedDemo, {});
      return closed ? { skipped: CLOSED_DEMO_SKIPPED } : await checkJourneys(ctx);
    }
    const swept: Swept = { started: [], skipped: [] };
    for (let claims = 0; claims < MAX_CLAIMS_PER_TICK; claims++) {
      const { started, skipped, more }: Swept & { more: boolean } = await ctx.runMutation(internal.protectedApp.watching.claim, {});
      swept.started.push(...started);
      swept.skipped.push(...skipped);
      if (!more) break;
    }
    return swept;
  },
});
