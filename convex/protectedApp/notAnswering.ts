import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { CLOSED_CASE_STATUSES, notAnsweringSignature, type Unanswered, type UnansweredTry } from "../constants";
import { createCaseFromTemplate, finishAttempt, setCaseStatus, startAttempt, waitOnAttempt } from "../workflow";
import { turtlReachable } from "./client";
import { MAX_JOURNEYS } from "./watching";

// Cases for an app that stops answering turtl's checks.
//
// Each check (a journeys row) counts the monitor's tries in a row that got no usable answer: no response at all, or a
// reply with no check result (convex/protectedApp/client.ts, runJourneyCheck). A request turtl refused to send never
// counts: the app was not asked. Only the monitor's own rounds count (monitor.ts calls settleRound at the end of a
// round); a case's steps check the app too, and those tries count for nothing here. Any usable reply, a pass or a
// failure, clears the count, and so does a pass a case's verify step records (monitor.ts, recordPass).
//
// At UNANSWERED_AFTER in a row a check is not answering. After a round in which a check that ran is not answering, one
// case opens for the whole project (signature not_answering:<appId>), however many of its checks stopped answering:
// raised by the monitor, an outage, no journey, status waiting_for_app, and one step parked as waiting from the start,
// never dispatched to a handler, so it has no time limit, no retries and no model call. Before it opens, turtl asks its
// own site whether its requests are getting out at all; if not, nothing opens and the counts stay one short of the
// threshold, so the next round asks again. At most NOT_ANSWERING_CASES_PER_DAY such cases open for one project a day.
//
// The case closes at the end of a round in which no check that ran is still not answering: resolved, with a second
// notice, when the app answered; unresolved and with no notice when turtl stopped checking (every check refused, the
// project skipped or left with nothing to check: watching.ts schedules `stopped`). A check that is no longer run loses
// its count at the next round's end.
//
// With accounts on, before a case opens and before turtl asks its own site, turtl looks across the fleet (fleetQuiet):
// when at least FLEET_EVIDENCE other projects that answered within FLEET_ANSWERED_WITHIN_MS were checked since this one
// went quiet, and not one of them got a usable reply in its latest round, the trouble is more likely turtl's own, and
// the case is held back exactly as when turtl's own site does not answer. Such a hold lasts about half an hour: from the
// inside, a host that every sampled project shares going down looks the same as turtl's own trouble, so once the
// others' last answers are older than that they are no longer evidence, and the case opens if turtl's own site answers.
//
// A practice project (convex/practice) is out of all this: its app is turtl's own code on turtl's own site, so a check
// of it that gets no usable reply is turtl's trouble, not its owner's. Its checks keep no count, it gets no case and no
// notice, and the backend log hears of it once a round (monitor.ts).
//
// A round settles only what is newer than what a check has on record: a try older than the check's latest unanswered
// try or its latest pass (a round that finished after a newer one) changes nothing, as openCase ignores an old failure.
//
// Every read here is bounded: a project's checks (MAX_JOURNEYS), its newest NOT_ANSWERING_CASES_PER_DAY such cases, and
// for the fleet FLEET_SAMPLE monitor rows. None of it runs on a round when no check of the project has a count and none
// went unanswered (monitor.ts).

/** Tries in a row with no usable answer after which a check is not answering. */
export const UNANSWERED_AFTER = 3;
/** The most not-answering cases that open for one project in 24 hours. */
export const NOT_ANSWERING_CASES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;
/** A case stops counting as open once it is closed (as in monitor.ts; such a case is never restored). */
const NOT_OPEN: readonly string[] = [...CLOSED_CASE_STATUSES, "restored"];

/** Its one step: parked as waiting when the case opens, finished when it closes. Never dispatched. */
export const WAIT_STEP = { key: "wait_for_answer", title: "Wait for the app to answer", dependsOn: [], kind: "function" as const, purpose: "detect_or_receive" as const };

const NOT_SENT = "turtl could not send its checks to the app.";
const TITLE = "Your app is not answering turtl's checks";
const WAITING = "turtl's checks get no answer from the app. turtl cannot propose a fix for an app it cannot reach, so it keeps checking and closes this case when the app answers.";
const OFFLINE =
  "A not-answering case was held back: turtl's own site did not answer turtl's request, so turtl's own requests may not be getting out. The next round of that project's checks asks again.";
const FLEET_QUIET =
  "A not-answering case was held back: the other projects turtl checked since that project went quiet got no usable reply either, so the trouble is more likely turtl's own than the app's. The next round of that project's checks asks again.";
/** For the operator's log, once a round: a practice project's check got no usable reply. */
export const PRACTICE_QUIET =
  "turtl's own practice app did not answer turtl's checks. That is turtl's own site or code in trouble, not an owner's app, so no not-answering case was opened.";
/** Why a not-answering case on a practice project (from before they were left out) closed. */
const PRACTICE = "This is your practice app, which runs on turtl's own site, so turtl does not open a case when it does not answer.";

/** The fleet check: rows of the monitor it samples, how many other projects it needs, and how far back a due time reaches. */
const FLEET_SAMPLE = 40;
const FLEET_EVIDENCE = 5;
const FLEET_RECENT_MS = 5 * 60_000;
/**
 * How recently another project must have answered to count as evidence: so a fleet-wide quiet spell holds a case for
 * about half an hour, never longer. A shared host's outage and turtl's own trouble look the same from inside, and an
 * owner whose app is down behind a shared host must still be told.
 */
export const FLEET_ANSWERED_WITHIN_MS = 30 * 60_000;

/** What one of the monitor's tries of one check got. */
const vGot = v.union(
  v.object({ kind: v.literal("passed") }),
  v.object({ kind: v.literal("failed") }),
  v.object({ kind: v.literal("not_sent") }),
  v.object({ kind: v.literal("no_response"), timedOut: v.boolean() }),
  v.object({ kind: v.literal("no_result"), status: v.number() }),
);
export const vTry = v.object({ journeyId: v.id("journeys"), at: v.number(), got: vGot });
export type Try = Infer<typeof vTry>;

/** Whether a try counts: the request went out and nothing usable came back. */
export const counts = (got: Try["got"]): got is UnansweredTry => got.kind === "no_response" || got.kind === "no_result";
/** Whether a check is not answering now. */
export const isNotAnswering = (journey: { unanswered?: Unanswered }) => (journey.unanswered?.count ?? 0) >= UNANSWERED_AFTER;

const journeysOf = (ctx: Pick<MutationCtx, "db">, appId: Id<"apps">) =>
  ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).take(MAX_JOURNEYS);

/** The project's newest not-answering cases, newest first: enough for the daily limit, and the open one if any. */
const recentCases = (ctx: Pick<MutationCtx, "db">, appId: Id<"apps">) =>
  ctx.db
    .query("cases")
    .withIndex("by_app_and_signature", (q) => q.eq("appId", appId).eq("signature", notAnsweringSignature(appId)))
    .order("desc")
    .take(NOT_ANSWERING_CASES_PER_DAY);

const openOf = (recent: Doc<"cases">[]) => recent.find((row) => !NOT_OPEN.includes(row.status)) ?? null;
const limitReached = (recent: Doc<"cases">[], now: number) => recent.filter((row) => row._creationTime > now - DAY_MS).length >= NOT_ANSWERING_CASES_PER_DAY;

/** A check's count after one try: one more for a try that counts, cleared by anything else. */
function after(previous: Unanswered | undefined, tried: Try): Unanswered | undefined {
  if (!counts(tried.got)) return undefined;
  const latest: UnansweredTry = tried.got.kind === "no_response" ? { kind: "no_response", timedOut: tried.got.timedOut } : { kind: "no_result", status: tried.got.status };
  return { count: (previous?.count ?? 0) + 1, since: previous?.since ?? tried.at, at: tried.at, latest };
}

// ---- Words. Owners read these on the case: plain sentences, no error names, ids or settings. An HTTP status is fine.

function quoted(names: string[]): string {
  const shown = names.slice(0, 3).map((name) => `"${name}"`);
  if (names.length > 3) return `${shown.join(", ")} and ${names.length - 3} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

function sawWords(latest: UnansweredTry): string {
  if (latest.kind === "no_result") return `the app replied with HTTP ${latest.status} but no check result`;
  return latest.timedOut ? "the app did not reply in time" : "turtl could not connect to the app";
}

function about(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 2) return "a minute";
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

function impactOf(quiet: Doc<"journeys">[]): string {
  const tries = Math.min(...quiet.map((journey) => journey.unanswered!.count));
  const latest = quiet.reduce((newest, journey) => (journey.unanswered!.at > newest.unanswered!.at ? journey : newest)).unanswered!.latest;
  const names = quiet.map((journey) => journey.name);
  const which = names.length === 1 ? `the ${quoted(names)} check` : `${names.length} checks (${quoted(names)})`;
  return `turtl's last ${tries} tries of ${which} got no usable answer: ${sawWords(latest)}. turtl cannot propose a fix for an app it cannot reach. It keeps checking, and closes this case when the app answers again.`;
}

/** How the checks stand now that the app answered: the ones that fail, and the ones still with no answer. */
function nowWords(journeys: Doc<"journeys">[], tries: Try[]): string {
  const names = (kind: (got: Try["got"]) => boolean) =>
    tries.filter((tried) => kind(tried.got)).flatMap((tried) => journeys.filter((journey) => journey._id === tried.journeyId).map((journey) => journey.name));
  const failing = names((got) => got.kind === "failed");
  const quiet = names(counts);
  const parts = [];
  if (failing.length) parts.push(`${quoted(failing)} ${failing.length === 1 ? "fails" : "fail"} now, which turtl handles as a separate issue.`);
  if (quiet.length) parts.push(`${quoted(quiet)} got no answer this time.`);
  return parts.length ? parts.join(" ") : "Its checks pass now.";
}

const stoppedWords = (reason: string) => `turtl stopped checking this project, so it closed this case without knowing whether the app answers again. ${reason}`;

// ---- Opening and closing

async function waitingAttempt(ctx: MutationCtx, caseId: Id<"cases">) {
  const step = await ctx.db.query("steps").withIndex("by_case_and_key", (q) => q.eq("caseId", caseId).eq("key", WAIT_STEP.key)).unique();
  return step?.currentAttemptId ? await ctx.db.get(step.currentAttemptId) : null;
}

/** When the app went quiet, as the case recorded it when it opened. */
const quietSince = (attempt: Doc<"stepAttempts"> | null, row: Doc<"cases">): number => {
  const since = (attempt?.output as { quietSince?: unknown } | undefined)?.quietSince;
  return typeof since === "number" ? since : row._creationTime;
};

async function close(ctx: MutationCtx, row: Doc<"cases">, how: { answered: true; tail: string } | { answered: false; reason: string }) {
  const now = Date.now();
  const attempt = await waitingAttempt(ctx, row._id);
  const since = quietSince(attempt, row);
  const summary = how.answered
    ? `The app answered turtl's checks again after about ${about(now - since)} without an answer. ${how.tail}`
    : stoppedWords(how.reason);
  if (attempt) await finishAttempt(ctx, attempt._id, { status: "done", summary, output: { quietSince: since, closedAt: now, answered: how.answered } });
  await setCaseStatus(ctx, row._id, how.answered ? "resolved" : "unresolved");
  if (how.answered) {
    const app = await ctx.db.get(row.appId);
    await ctx.scheduler.runAfter(0, internal.notices.notifyOwner, {
      caseId: row._id,
      event: "answering_again",
      text: `${app?.name ?? "Your app"} is answering turtl's checks again. Open the case in turtl to see whether they pass.`,
    });
  }
}

async function openFor(ctx: MutationCtx, app: Doc<"apps">, quiet: Doc<"journeys">[]): Promise<Id<"cases">> {
  const caseId = await createCaseFromTemplate(
    ctx,
    { appId: app._id, title: TITLE, impact: impactOf(quiet), kind: "outage", raisedBy: "monitor", raisedByRef: "turtl's checks", signature: notAnsweringSignature(app._id) },
    [WAIT_STEP],
  );
  await setCaseStatus(ctx, caseId, "waiting_for_app");
  const step = await ctx.db.query("steps").withIndex("by_case_and_key", (q) => q.eq("caseId", caseId).eq("key", WAIT_STEP.key)).unique();
  const attemptId = await startAttempt(ctx, step!._id);
  await waitOnAttempt(ctx, attemptId, { summary: WAITING });
  await ctx.db.patch(attemptId, { output: { quietSince: Math.min(...quiet.map((journey) => journey.unanswered!.since)) } });
  await ctx.scheduler.runAfter(0, internal.notices.notifyOwner, {
    caseId,
    event: "not_answering",
    text: `${app.name} is not answering turtl's checks. turtl keeps checking and tells you when it answers again.`,
  });
  return caseId;
}

// ---- The monitor's side

const vSettled = v.union(
  v.object({ kind: v.literal("none") }),
  // ran: the checks this round's newer tries reached; since: when the first of its not-answering checks went quiet.
  v.object({ kind: v.literal("would_open"), ran: v.array(v.id("journeys")), since: v.number() }),
  v.object({ kind: v.literal("daily_limit") }),
  v.object({ kind: v.literal("open"), caseId: v.id("cases") }),
  v.object({ kind: v.literal("closed"), caseId: v.id("cases"), answered: v.boolean() }),
);

/** Whether a try is older than what its check already has on record: its latest unanswered try, or its latest pass. */
const older = (journey: Doc<"journeys">, one: Try) => one.at < (journey.unanswered?.at ?? 0) || one.at < (journey.lastPassedAt ?? 0);

/**
 * The end of one round of a project's checks: counts this round's tries on their checks, clears the count of any check
 * the round did not run, and closes an open case when no check that ran is still not answering. A try older than what
 * its check has on record changes nothing. Says `would_open` when a case would open, which `open` decides once turtl has
 * looked across the fleet and asked its own site (settleRound). A practice project keeps no count and gets no case.
 */
export const settle = internalMutation({
  args: { appId: v.id("apps"), tries: v.array(vTry) },
  returns: vSettled,
  handler: async (ctx, { appId, tries }): Promise<Infer<typeof vSettled>> => {
    if ((await ctx.db.get(appId))?.practice) {
      await stopWatching(ctx, appId, PRACTICE);
      return { kind: "none" };
    }
    const tried = new Map(tries.map((one) => [one.journeyId as string, one]));
    const journeys = await journeysOf(ctx, appId);
    const fresh: Try[] = [];
    for (const journey of journeys) {
      const one = tried.get(journey._id);
      if (one && older(journey, one)) continue;
      if (one) fresh.push(one);
      const next = one ? after(journey.unanswered, one) : undefined;
      if (next || journey.unanswered) {
        await ctx.db.patch(journey._id, { unanswered: next });
        journey.unanswered = next;
      }
    }
    const reached = new Set(fresh.filter((one) => one.got.kind !== "not_sent").map((one) => one.journeyId as string));
    const ran = journeys.filter((journey) => reached.has(journey._id));
    const quiet = ran.filter(isNotAnswering);
    const recent = await recentCases(ctx, appId);
    const open = openOf(recent);
    if (open) {
      if (quiet.length) return { kind: "open", caseId: open._id };
      if (fresh.some((one) => one.got.kind === "passed" || one.got.kind === "failed")) {
        await close(ctx, open, { answered: true, tail: nowWords(journeys, fresh) });
        return { kind: "closed", caseId: open._id, answered: true };
      }
      if (fresh.length > 0 && fresh.every((one) => one.got.kind === "not_sent")) {
        await close(ctx, open, { answered: false, reason: NOT_SENT });
        return { kind: "closed", caseId: open._id, answered: false };
      }
      // Some checks got no answer again, just not three times yet, or only older results came back: no answer yet.
      return { kind: "open", caseId: open._id };
    }
    if (!quiet.length) return { kind: "none" };
    if (limitReached(recent, Date.now())) return { kind: "daily_limit" };
    return { kind: "would_open", ran: ran.map((journey) => journey._id), since: Math.min(...quiet.map((journey) => journey.unanswered!.since)) };
  },
});

/**
 * Across the fleet, with accounts on: whether every other project turtl checked since this one went quiet got no
 * usable reply either. Reads at most FLEET_SAMPLE monitor rows, due from FLEET_RECENT_MS ago on, through by_next_check.
 * Evidence is another project that answered within FLEET_ANSWERED_WITHIN_MS and was checked since `since`; it says
 * "quiet" when its latest round got no usable reply. Quiet when there are at least FLEET_EVIDENCE such projects and every
 * one is quiet. So a hold lasts about half an hour, until the others' last answers are older than that.
 */
export const fleetQuiet = internalQuery({
  args: { appId: v.id("apps"), since: v.number() },
  returns: v.object({ quiet: v.boolean(), others: v.number() }),
  handler: async (ctx, { appId, since }) => {
    const now = Date.now();
    const rows = await ctx.db.query("watchedProjects").withIndex("by_next_check", (q) => q.gte("nextCheckAt", now - FLEET_RECENT_MS)).take(FLEET_SAMPLE);
    const others = rows.filter((row) => row.appId !== appId && (row.lastCheckedAt ?? 0) >= since && (row.lastAnsweredAt ?? 0) >= now - FLEET_ANSWERED_WITHIN_MS);
    return { quiet: others.length >= FLEET_EVIDENCE && others.every((row) => row.lastAnsweredAt! < row.lastCheckedAt!), others: others.length };
  },
});

/**
 * Opens the project's not-answering case, deciding again in this one transaction: only if a check that ran is still not
 * answering, none is open and the day's limit is not reached, so two rounds never open two. With turtl's own requests
 * not getting out, opens nothing and holds those checks one short of the threshold, so the next round asks again.
 */
export const open = internalMutation({
  args: { appId: v.id("apps"), ran: v.array(v.id("journeys")), turtl: v.union(v.literal("reachable"), v.literal("unreachable")) },
  returns: v.union(v.null(), v.id("cases")),
  handler: async (ctx, { appId, ran, turtl }) => {
    const app = await ctx.db.get(appId);
    if (!app || app.practice) return null;
    const quiet = (await journeysOf(ctx, appId)).filter((journey) => ran.includes(journey._id) && isNotAnswering(journey));
    if (!quiet.length) return null;
    const recent = await recentCases(ctx, appId);
    if (openOf(recent) || limitReached(recent, Date.now())) return null;
    if (turtl === "unreachable") {
      for (const journey of quiet) await ctx.db.patch(journey._id, { unanswered: { ...journey.unanswered!, count: UNANSWERED_AFTER - 1 } });
      return null;
    }
    return await openFor(ctx, app, quiet);
  },
});

/**
 * Run by monitor.ts at the end of a round that has something to settle. When a case would open: with accounts on, the
 * fleet first, then turtl's own site; either one quiet holds the case back.
 */
export async function settleRound(ctx: Pick<ActionCtx, "runMutation" | "runQuery">, appId: Id<"apps">, tries: Try[]): Promise<void> {
  const settled: Infer<typeof vSettled> = await ctx.runMutation(internal.protectedApp.notAnswering.settle, { appId, tries });
  if (settled.kind !== "would_open") return;
  const hold = async (why: string) => {
    console.warn(why);
    await ctx.runMutation(internal.protectedApp.notAnswering.open, { appId, ran: settled.ran, turtl: "unreachable" });
  };
  if (accessEnforced()) {
    const fleet: { quiet: boolean } = await ctx.runQuery(internal.protectedApp.notAnswering.fleetQuiet, { appId, since: settled.since });
    if (fleet.quiet) return await hold(FLEET_QUIET);
  }
  if (!(await turtlReachable())) return await hold(OFFLINE);
  await ctx.runMutation(internal.protectedApp.notAnswering.open, { appId, ran: settled.ran, turtl: "reachable" });
}

/** turtl stopped checking the project (watching.ts, the single-owner demo in monitor.ts): its counts go, and an open
 * case closes unresolved with why, and with no "answering again" notice. */
export async function stopWatching(ctx: MutationCtx, appId: Id<"apps">, reason: string) {
  for (const journey of await journeysOf(ctx, appId)) if (journey.unanswered) await ctx.db.patch(journey._id, { unanswered: undefined });
  const open = openOf(await recentCases(ctx, appId));
  if (open) await close(ctx, open, { answered: false, reason });
}

export const stopped = internalMutation({
  args: { appId: v.id("apps"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { appId, reason }) => {
    await stopWatching(ctx, appId, reason);
    return null;
  },
});

/**
 * A pass recorded outside the monitor's rounds (a case's verify step): the check's count goes, and when no other check
 * of the project is still not answering, the open case closes as answered.
 */
export async function passedOutsideRound(ctx: MutationCtx, journey: Doc<"journeys">) {
  await ctx.db.patch(journey._id, { unanswered: undefined });
  const others = (await journeysOf(ctx, journey.appId)).filter((other) => other._id !== journey._id && isNotAnswering(other));
  if (others.length) return;
  const open = openOf(await recentCases(ctx, journey.appId));
  if (open) await close(ctx, open, { answered: true, tail: `${quoted([journey.name])} passed when another of this project's cases checked it.` });
}
