import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { CLOSED_CASE_STATUSES, notAnsweringSignature, type Unanswered, type UnansweredTry } from "../constants";
import { createCaseFromTemplate, finishAttempt, setCaseStatus, startAttempt, waitOnAttempt } from "../workflow";
import { turtlReachable } from "./client";
import { canStopAnswering, MAX_JOURNEYS } from "./watching";

// Cases for an app that stops answering turtl's checks. The case means what its title says: the app gives turtl
// nothing at all (the design's second revision, V1 to V6).
//
// What a try got (V1): not sent (turtl refused to send: evidence of nothing); answered (a check result, passed or
// failed, or any reply below 500 with or without one: a 404, a 401, a 429 or a redirect means the app is serving, though
// turtl cannot run that check there); or quiet (no response at all, or a reply of 500 or more with no check result).
// Only the monitor's own rounds count (monitor.ts calls settleRound at the end of a round); a case's steps check the app
// too, and those tries count for nothing here.
//
// Counting, per check (V2): only a check that can stop answering (watching.ts, canStopAnswering: a journey-contract
// check that has passed before) keeps a count, of quiet tries in a row, cleared by anything else; a pass a case's verify
// step records clears it too. At UNANSWERED_AFTER it shows as not answering on the project, case or no case.
//
// Evidence, per round (V3): every try the round sent, its check countable or not. A health check that answers turtl's
// POST with a 405 shows the app is serving.
//
// Opening (V4): one case for the whole project (signature not_answering:<appId>) after a round in which at least one
// countable check was sent, every countable check sent is at UNANSWERED_AFTER or more, and no check sent answered. So
// one check in trouble while another answers opens nothing: it shows on the project, with no push. The case is raised
// by the monitor, an outage, no journey, status waiting_for_app, with one step parked as waiting from the start, never
// dispatched, so it has no time limit, no retries and no model call. Before it opens: none already open, at most
// NOT_ANSWERING_CASES_PER_DAY a day, never a practice project, the fleet check, and turtl asking its own site; if either
// check says turtl's own requests may not be getting out, nothing opens and the counts are held one short.
//
// Closing (V5): at the end of a round in which any check answered, as answered, with a second notice; allPassed (read by
// the case page) only when a check passed, none failed and none sent was quiet. A pass recorded outside a round closes
// it too, allPassed only if no other check of the project has a count. When turtl stops checking (every check refused,
// the project skipped or left with nothing to check: watching.ts schedules `stopped`), it closes unresolved with no
// notice. The project's row records its open case (apps.notAnsweringCase), which the monitor reads on every turn, so a
// round is always settled while a case is open, whatever the counts say.
//
// The fleet check (V6), with accounts on, before turtl asks its own site: when at least FLEET_EVIDENCE other projects
// that answered within FLEET_ANSWERED_WITHIN_MS were checked since this one went quiet, and not one of them got a usable
// reply in its latest round, the trouble is more likely turtl's own, and the case is held. Practice projects are no
// evidence (they run on turtl's own site; monitor.ts never records them as answering). A hold never lasts past the point
// where this project has been quiet for FLEET_HOLD_AT_MOST_MS: a shared host's outage and turtl's own trouble look the
// same from inside, and an owner behind that host must still be told.
//
// A practice project (convex/practice) is out of all this: its app is turtl's own code on turtl's own site, so its
// checks keep no count, it gets no case and no notice, and the backend log hears of it once a round (monitor.ts).
//
// A round settles only what is newer than what a check has on record: a try older than the check's latest quiet try or
// its latest pass (a round that finished after a newer one) changes nothing, as openCase ignores an old failure.
//
// Every read here is bounded: a project's checks (MAX_JOURNEYS), its newest NOT_ANSWERING_CASES_PER_DAY such cases, and
// for the fleet FLEET_SAMPLE monitor rows. None of it runs on a round with no case open, no count on record and no
// countable check quiet (monitor.ts).

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
// True while the app is quiet and after the case closes.
const TITLE = "Your app stopped answering";
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
/** The longest a fleet hold lasts: once this project has been quiet this long, the case is no longer held for the fleet. */
export const FLEET_HOLD_AT_MOST_MS = 30 * 60_000;
/** A reply with no check result is quiet from this status up (a server error), and an answer below it (V1). */
export const QUIET_FROM_STATUS = 500;
/** The tail of a closing summary when the app answered but no check passed (a 404, say, or a health check's 405). */
const NONE_PASSED = "It answered, but none of its checks passed this time.";

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

/** Whether a try was quiet (V1): no response at all, or a reply of QUIET_FROM_STATUS or more with no check result. */
export const isQuiet = (got: Try["got"]): got is UnansweredTry => got.kind === "no_response" || (got.kind === "no_result" && got.status >= QUIET_FROM_STATUS);
/** Whether a try was answered (V1): a check result, or any reply below QUIET_FROM_STATUS. The app is serving. */
export const isAnswered = (got: Try["got"]) => got.kind === "passed" || got.kind === "failed" || (got.kind === "no_result" && got.status < QUIET_FROM_STATUS);
/** Whether a check is not answering now. Only a check that can stop answering ever is (watching.ts, canStopAnswering). */
export const isNotAnswering = (journey: Pick<Doc<"journeys">, "check" | "lastPassedAt"> & { unanswered?: Unanswered }) =>
  canStopAnswering(journey) && (journey.unanswered?.count ?? 0) >= UNANSWERED_AFTER;

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

/** A check's count after one try: one more for a quiet try, cleared by anything else. */
function after(previous: Unanswered | undefined, tried: Try): Unanswered | undefined {
  if (!isQuiet(tried.got)) return undefined;
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
  const latest = quiet.reduce((newest, journey) => (journey.unanswered!.at > newest.unanswered!.at ? journey : newest)).unanswered!.latest;
  const names = quiet.map((journey) => journey.name);
  const which = names.length === 1 ? `the ${quoted(names)} check` : `each of ${names.length} checks (${quoted(names)})`;
  // What turtl saw, and only that: the case page says what happens next while the case is open, and shows this line
  // again once it is closed (data/live/caseMapping.ts), when "it keeps checking" would no longer be true. No exact
  // count of tries: a count can be held below UNANSWERED_AFTER while turtl checks itself, so it may be stale by the
  // time the case opens. "three" is UNANSWERED_AFTER in words.
  return `At least three tries in a row of ${which} got no usable answer: ${sawWords(latest)}.`;
}

/**
 * How the checks stand now that the app answered, from every try the round sent (V3, V5): the ones that fail, and the
 * ones still quiet, in words; and allPassed, true only when one passed, none failed and none was quiet. A check that
 * answered without a result (a 404, a health check's 405) neither passes nor spoils it.
 */
function nowWords(journeys: Doc<"journeys">[], sent: Try[]): { tail: string; allPassed: boolean } {
  const names = (kind: (got: Try["got"]) => boolean) =>
    sent.filter((tried) => kind(tried.got)).flatMap((tried) => journeys.filter((journey) => journey._id === tried.journeyId).map((journey) => journey.name));
  const failing = names((got) => got.kind === "failed");
  const quiet = names(isQuiet);
  const anyPassed = sent.some((tried) => tried.got.kind === "passed");
  const parts = [];
  if (failing.length) parts.push(`${quoted(failing)} ${failing.length === 1 ? "fails" : "fail"} now, which turtl handles as a separate issue.`);
  if (quiet.length) parts.push(`${quoted(quiet)} got no answer this time.`);
  const allPassed = anyPassed && !sent.some((tried) => tried.got.kind === "failed" || isQuiet(tried.got));
  return { tail: parts.length ? parts.join(" ") : anyPassed ? "Its checks pass now." : NONE_PASSED, allPassed };
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

/**
 * Closes the case. Its step's output records when the app went quiet, when the case closed, whether the app answered,
 * and whether every check that ran then passed (false when turtl stopped checking: nothing ran). The case page reads
 * these, never the summary's words.
 */
async function close(ctx: MutationCtx, row: Doc<"cases">, how: { answered: true; tail: string; allPassed: boolean } | { answered: false; reason: string }) {
  const now = Date.now();
  const attempt = await waitingAttempt(ctx, row._id);
  const since = quietSince(attempt, row);
  const summary = how.answered
    ? `The app answered turtl's checks again after about ${about(now - since)} without an answer. ${how.tail}`
    : stoppedWords(how.reason);
  const allPassed = how.answered && how.allPassed;
  if (attempt) await finishAttempt(ctx, attempt._id, { status: "done", summary, output: { quietSince: since, closedAt: now, answered: how.answered, allPassed } });
  await setCaseStatus(ctx, row._id, how.answered ? "resolved" : "unresolved");
  const app = await ctx.db.get(row.appId);
  // The project no longer has an open case to settle each round for.
  if (app?.notAnsweringCase === row._id) await ctx.db.patch(app._id, { notAnsweringCase: undefined });
  if (how.answered) {
    await ctx.scheduler.runAfter(0, internal.notices.notifyOwner, {
      caseId: row._id,
      event: "answering_again",
      // Not an all-clear: the app can come back with a failing check. The push says the same (convex/push/message.ts);
      // a text message is read outside the app, so it says where the case is.
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
  // Recorded on the project's own row, which the monitor reads on every turn: each round is settled while it is open.
  await ctx.db.patch(app._id, { notAnsweringCase: caseId });
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
 * The end of one round of a project's checks. Counts each countable check's quiet tries (V2), clearing the count of any
 * check the round did not run; takes every try the round sent as evidence (V3); closes an open case when any check
 * answered (V5); and says `would_open` when a case would open (V4), which `open` decides once turtl has looked across the
 * fleet and asked its own site (settleRound). A try older than what its check has on record changes nothing. A
 * practice project keeps no count and gets no case. Keeps the project's record of its open case true.
 */
export const settle = internalMutation({
  args: { appId: v.id("apps"), tries: v.array(vTry) },
  returns: vSettled,
  handler: async (ctx, { appId, tries }): Promise<Infer<typeof vSettled>> => {
    const app = await ctx.db.get(appId);
    if (!app) return { kind: "none" };
    if (app.practice) {
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
      // Only a check that can stop answering keeps a count (a health or readiness journey, or one that has never passed,
      // does not); a check the round did not try loses its count.
      const next = one && canStopAnswering(journey) ? after(journey.unanswered, one) : undefined;
      if (next || journey.unanswered) {
        await ctx.db.patch(journey._id, { unanswered: next });
        journey.unanswered = next;
      }
    }
    const sent = fresh.filter((one) => one.got.kind !== "not_sent");
    const answered = sent.some((one) => isAnswered(one.got));
    const reached = new Set(sent.map((one) => one.journeyId as string));
    const counted = journeys.filter((journey) => reached.has(journey._id) && canStopAnswering(journey));
    const recent = await recentCases(ctx, appId);
    const open = openOf(recent);
    if ((app.notAnsweringCase ?? null) !== (open?._id ?? null)) await ctx.db.patch(appId, { notAnsweringCase: open?._id });
    if (open) {
      if (answered) {
        await close(ctx, open, { answered: true, ...nowWords(journeys, sent) });
        return { kind: "closed", caseId: open._id, answered: true };
      }
      if (fresh.length > 0 && sent.length === 0) {
        await close(ctx, open, { answered: false, reason: NOT_SENT });
        return { kind: "closed", caseId: open._id, answered: false };
      }
      // Nothing answered, or only older results came back: the app has not answered yet.
      return { kind: "open", caseId: open._id };
    }
    if (answered || counted.length === 0 || !counted.every(isNotAnswering)) return { kind: "none" };
    if (limitReached(recent, Date.now())) return { kind: "daily_limit" };
    return { kind: "would_open", ran: counted.map((journey) => journey._id), since: Math.min(...counted.map((journey) => journey.unanswered!.since)) };
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
 * Opens the project's not-answering case, deciding again in this one transaction: only if every countable check the
 * round sent (`ran`) is still not answering (a newer round in which one answered has cleared it), none is open and the
 * day's limit is not reached, so two rounds never open two. With turtl's own requests possibly not getting out, opens
 * nothing and holds those checks one short of the threshold, so the next round asks again.
 */
export const open = internalMutation({
  args: { appId: v.id("apps"), ran: v.array(v.id("journeys")), turtl: v.union(v.literal("reachable"), v.literal("unreachable")) },
  returns: v.union(v.null(), v.id("cases")),
  handler: async (ctx, { appId, ran, turtl }) => {
    const app = await ctx.db.get(appId);
    if (!app || app.practice) return null;
    const quiet = (await journeysOf(ctx, appId)).filter((journey) => ran.includes(journey._id));
    if (!quiet.length || !quiet.every(isNotAnswering)) return null;
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
 * Run by monitor.ts at the end of a round that has something to settle. When a case would open: with accounts on, and
 * only while this project has been quiet for less than FLEET_HOLD_AT_MOST_MS, the fleet first; then turtl's own site.
 * Either one quiet holds the case back.
 */
export async function settleRound(ctx: Pick<ActionCtx, "runMutation" | "runQuery">, appId: Id<"apps">, tries: Try[]): Promise<void> {
  const settled: Infer<typeof vSettled> = await ctx.runMutation(internal.protectedApp.notAnswering.settle, { appId, tries });
  if (settled.kind !== "would_open") return;
  const hold = async (why: string) => {
    console.warn(why);
    await ctx.runMutation(internal.protectedApp.notAnswering.open, { appId, ran: settled.ran, turtl: "unreachable" });
  };
  if (accessEnforced() && Date.now() - settled.since < FLEET_HOLD_AT_MOST_MS) {
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
 * A pass recorded outside the monitor's rounds (a case's verify step): the check's count goes, and an open case closes
 * as answered (V5), allPassed only if no other check of the project has a count. Reads the project's row, and its cases
 * and checks only when it records an open case.
 */
export async function passedOutsideRound(ctx: MutationCtx, journey: Doc<"journeys">) {
  if (journey.unanswered) await ctx.db.patch(journey._id, { unanswered: undefined });
  if (!(await ctx.db.get(journey.appId))?.notAnsweringCase) return;
  const open = openOf(await recentCases(ctx, journey.appId));
  if (!open) return;
  const others = (await journeysOf(ctx, journey.appId)).filter((other) => other._id !== journey._id && other.unanswered !== undefined);
  await close(ctx, open, { answered: true, tail: `${quoted([journey.name])} passed when another of this project's cases checked it.`, allPassed: others.length === 0 });
}
