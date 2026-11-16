import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { action, mutation, query } from "../functions";
import { accessEnforced, currentAccount, requireApp } from "../access";
import { CLOSED_CASE_STATUSES } from "../constants";
import { liveAddressProblem } from "../protectedApp/address";
import { CHECK_VERSION, CREDENTIAL_REF } from "../protectedApp/client";
import { takeTurn } from "../protectedApp/watching";
import { storeManagedControlToken } from "../secrets/managed";
import { sealingKey } from "../secrets/seal";
import { projectSecret } from "../secrets/store";
import { NO_SEALING_KEY } from "../secrets/words";
import { tokenHashOf } from "./http";
import { allowance, BREAKS, failureOf, noteOf, PRACTICE_APP_NAME, PRACTICE_WORDS, practiceBase, practiceBreaksPerDay, WORKING, type Switches } from "./rules";
import { vPracticeFailure, type PracticeFailure } from "./schema";

declare const process: { env: Record<string, string | undefined> };

// A practice project: a project an account owns whose live app is a practice app turtl runs (convex/practice/app.ts),
// served on this deployment's own site address (http.ts) and answering only to the project's own control token. It has
// no repository. Everything after it breaks is turtl's ordinary machinery: the monitor notices, a case opens, and the
// fixes on offer are the two switches in its action catalog.
//
// Only with accounts on (AUTH_REQUIRED=true). One per account: asking again returns the same project. The owner breaks
// it on purpose, at most practiceBreaksPerDay() times a UTC day, and only while it works and no case is open on it, so
// the button can neither run up a bill nor flood the scheduler: each break starts one check.

/** A case stops counting as open once it is closed or its service is restored (as in convex/monitor.ts). */
const NOT_OPEN: readonly string[] = [...CLOSED_CASE_STATUSES, "restored"];
/** A practice project whose token was never stored is made again by the next Create after this long. */
const UNFINISHED_MS = 60_000;

type Read = Pick<QueryCtx, "db">;

const siteUrl = () => process.env.CONVEX_SITE_URL?.replace(/\/+$/, "") ?? "";

/** Why this backend cannot run practice apps, or null when it can: its own address must be one turtl may watch. */
export function practiceProblem(): string | null {
  if (!accessEnforced()) return PRACTICE_WORDS.demo;
  const site = siteUrl();
  return site && liveAddressProblem(practiceBase(site, "probe")) === null ? null : PRACTICE_WORDS.noSite;
}

const switchesOf = (row: Doc<"practiceApps">): Switches => ({
  recommendationsEnabled: row.recommendationsEnabled,
  providerTimeout: row.providerTimeout,
  bookingStoreFailure: row.bookingStoreFailure,
  backupStoreEnabled: row.backupStoreEnabled,
});

const practiceRow = (ctx: Read, appId: Id<"apps">) => ctx.db.query("practiceApps").withIndex("by_app", (q) => q.eq("appId", appId)).first();

/** The account's practice row, when the project it names is still theirs. */
async function practiceOf(ctx: Read, account: string): Promise<{ row: Doc<"practiceApps">; app: Doc<"apps"> } | null> {
  const row = await ctx.db.query("practiceApps").withIndex("by_owner", (q) => q.eq("ownerId", account)).first();
  const app = row ? await ctx.db.get(row.appId) : null;
  return row && app && app.ownerId === account && app.practice ? { row, app } : null;
}

const recentCases = (ctx: Read, appId: Id<"apps">) => ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", appId)).order("desc").take(20);

/** The newest case on the practice project that is still open. */
async function openCase(ctx: Read, appId: Id<"apps">): Promise<Doc<"cases"> | null> {
  return (await recentCases(ctx, appId)).find((row) => !NOT_OPEN.includes(row.status)) ?? null;
}

const vView = v.object({
  projectId: v.string(),
  name: v.string(),
  /** What breaks a booking now, or null when the practice app works. */
  failure: v.union(v.null(), vPracticeFailure),
  brokenAt: v.optional(v.number()),
  /** The open case on it, if any, and where it is: working it out, a fix waiting for the owner, or carrying one out. */
  caseId: v.optional(v.string()),
  caseStage: v.optional(v.union(v.literal("working"), v.literal("waiting"), v.literal("carrying_out"))),
  /** Still broken after a case on this break closed unfixed (its fixes declined, or it ended unresolved): turtl opens
   * no new case until the app has passed a check again, so the owner can put it back. */
  stalled: v.optional(v.boolean()),
  breaksLeft: v.number(),
  /** When today's breaks count from zero again: the next day boundary of the allowance (UTC midnight). */
  breaksResetAt: v.number(),
  /** What an earlier fix left switched, for a practice app that works again. */
  note: v.optional(v.string()),
});

/** Where an open case on a practice app is, in the three stages the practice sheet tells apart. */
export function stageOf(status: string): "working" | "waiting" | "carrying_out" {
  if (status === "waiting_for_owner") return "waiting";
  return status === "executing" || status === "waiting_for_deploy" || status === "verifying" ? "carrying_out" : "working";
}

/** The start of the next allowance day after a moment: dayOf counts days in UTC, so the next UTC midnight. */
export function nextDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

// What the app shows about practice: whether this account can have a practice app, and its practice project.
export const status = query({
  args: {},
  returns: v.object({ available: v.boolean(), breaksPerDay: v.number(), project: v.union(v.null(), vView) }),
  handler: async (ctx) => {
    const account = await currentAccount(ctx);
    const breaksPerDay = practiceBreaksPerDay();
    if (!accessEnforced() || !account) return { available: false, breaksPerDay, project: null };
    const found = await practiceOf(ctx, account);
    if (!found) return { available: practiceProblem() === null, breaksPerDay, project: null };
    const { row, app } = found;
    const switches = switchesOf(row);
    const failure = failureOf(switches);
    const recent = await recentCases(ctx, app._id);
    const open = recent.find((row) => !NOT_OPEN.includes(row.status)) ?? null;
    const closed: readonly string[] = CLOSED_CASE_STATUSES;
    const stalled = !!failure && !open && !!row.broken && recent.some((row2) => row2._creationTime >= row.broken!.at && closed.includes(row2.status));
    const note = noteOf(switches);
    return {
      available: true,
      breaksPerDay,
      project: {
        projectId: app._id as string,
        name: app.name,
        failure,
        ...(failure && row.broken && { brokenAt: row.broken.at }),
        ...(open && { caseId: open._id as string, caseStage: stageOf(open.status) }),
        ...(stalled && { stalled: true }),
        breaksLeft: allowance(row.breaks, Date.now(), breaksPerDay).left,
        breaksResetAt: nextDay(Date.now()),
        ...(note && { note }),
      },
    };
  },
});

// The project, its journey and its catalog: two switches turtl can flip on the practice app, and nothing that reaches a
// repository. Run inside the mutation that creates the project, so a project never exists without them.
async function insertPractice(ctx: MutationCtx, account: string, tokenHash: string): Promise<Id<"apps">> {
  const appId = await ctx.db.insert("apps", { name: PRACTICE_APP_NAME, ownerId: account, practice: true });
  const base = practiceBase(siteUrl(), appId);
  await ctx.db.patch(appId, { productionUrl: base });
  await ctx.db.insert("practiceApps", { appId, ownerId: account, tokenHash, ...WORKING, updatedAt: Date.now() });
  await ctx.db.insert("journeys", {
    appId,
    name: "Book an appointment",
    description: "A customer picks a service and a time and gets a confirmation backed by a saved booking. turtl makes a test booking in your practice app and deletes it straight after.",
    check: { kind: "http", config: { url: `${base}/journey-check`, method: "POST", expectedStatus: 200, credentialRef: CREDENTIAL_REF } },
    checkVersion: CHECK_VERSION,
  });
  await ctx.db.insert("actionCatalog", {
    appId,
    type: "set_feature_flag",
    name: "Turn off recommendations",
    description: "Sets the practice app's recommendationsEnabled switch to false, so booking stops waiting for suggested services. Reversible: set it back to true.",
    reversible: true,
    config: { kind: "http", url: `${base}/flags`, method: "POST", credentialRef: CREDENTIAL_REF },
    parameterConstraints: [
      { name: "flag", type: "string", required: true, allowedValues: ["recommendationsEnabled"] },
      { name: "value", type: "boolean", required: true, allowedValues: [false] },
    ],
  });
  await ctx.db.insert("actionCatalog", {
    appId,
    type: "set_feature_flag",
    name: "Save bookings to the backup store",
    description: "Sets the practice app's backupStoreEnabled switch to true, so new bookings are saved to its backup store while the main one is down. Reversible: set it back to false.",
    reversible: true,
    config: { kind: "http", url: `${base}/backup-store`, method: "POST", credentialRef: CREDENTIAL_REF },
    parameterConstraints: [
      { name: "flag", type: "string", required: true, allowedValues: ["backupStoreEnabled"] },
      { name: "value", type: "boolean", required: true, allowedValues: [true] },
    ],
  });
  return appId;
}

// The account's practice project and whether its control token is stored. For create, before it makes one.
export const mine = internalQuery({
  args: { account: v.string() },
  returns: v.union(v.null(), v.object({ appId: v.id("apps"), hasToken: v.boolean() })),
  handler: async (ctx, { account }) => {
    const found = await practiceOf(ctx, account);
    return found ? { appId: found.app._id, hasToken: (await projectSecret(ctx, found.app._id, "control_token")) !== null } : null;
  },
});

// Makes the account's practice project, or hands back the one it has. `seal` says the caller must store the token whose
// hash it passed: a new project, or one whose earlier Create stopped before its token was stored.
export const claim = internalMutation({
  args: { account: v.string(), tokenHash: v.string() },
  returns: v.object({ appId: v.id("apps"), seal: v.boolean() }),
  handler: async (ctx, { account, tokenHash }) => {
    const problem = practiceProblem();
    if (problem) throw new ConvexError(problem);
    const found = await practiceOf(ctx, account);
    if (!found) return { appId: await insertPractice(ctx, account, tokenHash), seal: true };
    const { row, app } = found;
    const unfinished = (await projectSecret(ctx, app._id, "control_token")) === null && Date.now() - row._creationTime > UNFINISHED_MS;
    if (unfinished) await ctx.db.patch(row._id, { tokenHash });
    return { appId: app._id, seal: unfinished };
  },
});

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The account's practice project, made if it has none. Its control token is made here, sealed, and never seen again. */
export async function ensurePractice(ctx: Pick<ActionCtx, "runQuery" | "runMutation">, account: string): Promise<Id<"apps">> {
  const existing: { appId: Id<"apps">; hasToken: boolean } | null = await ctx.runQuery(internal.practice.projects.mine, { account });
  if (existing?.hasToken) return existing.appId;
  const problem = practiceProblem();
  if (problem) throw new ConvexError(problem);
  const key = await sealingKey();
  if (!key) throw new ConvexError(NO_SEALING_KEY);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const claimed: { appId: Id<"apps">; seal: boolean } = await ctx.runMutation(internal.practice.projects.claim, { account, tokenHash: await tokenHashOf(token) });
  if (claimed.seal) {
    await storeManagedControlToken(ctx, { account, appId: claimed.appId, token, key });
    await ctx.runMutation(internal.practice.projects.firstCheck, { appId: claimed.appId });
  }
  return claimed.appId;
}

// A new practice app gets its monitor turn at once, so its home shows its booking check passing, not "not checked yet".
export const firstCheck = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.null(),
  handler: async (ctx, { appId }) => {
    const app = await ctx.db.get(appId);
    if (app?.practice) await takeTurn(ctx, app, Date.now());
    return null;
  },
});

// From the first-run screen or Add project: the signed-in account's practice project, made the first time.
export const create = action({
  args: {},
  returns: v.object({ projectId: v.string() }),
  handler: async (ctx): Promise<{ projectId: string }> => {
    const account: string = await ctx.runQuery(internal.access.account, {});
    return { projectId: await ensurePractice(ctx, account) };
  },
});

/** The project's practice row, for a project the caller may change (requireApp, in the handler). */
async function practiceRowOf(ctx: MutationCtx, app: Doc<"apps">) {
  const row = app.practice ? await practiceRow(ctx, app._id) : null;
  if (!row) throw new ConvexError(PRACTICE_WORDS.notPractice);
  return row;
}

const appIdOf = (ctx: MutationCtx, projectId: string) => {
  const appId = ctx.db.normalizeId("apps", projectId);
  if (!appId) throw new ConvexError(PRACTICE_WORDS.notPractice);
  return appId;
};

/** Switches the practice app to `next` and gives the project its monitor turn now, so turtl notices without waiting. */
async function setState(ctx: MutationCtx, app: Doc<"apps">, row: Doc<"practiceApps">, next: Switches, extra: Partial<Doc<"practiceApps">> = {}) {
  const now = Date.now();
  await ctx.db.patch(row._id, { ...next, updatedAt: now, ...extra });
  await takeTurn(ctx, app, now);
}

/** Breaks a working practice app with no open case. `counted`: the owner's daily allowance applies (the review account's
 * setup by the operator does not count against it). */
async function breakPractice(ctx: MutationCtx, app: Doc<"apps">, row: Doc<"practiceApps">, failure: PracticeFailure, counted: boolean) {
  if (failureOf(switchesOf(row))) throw new ConvexError(PRACTICE_WORDS.alreadyBroken);
  if (await openCase(ctx, app._id)) throw new ConvexError(PRACTICE_WORDS.caseOpen);
  const now = Date.now();
  const limit = practiceBreaksPerDay();
  const used = allowance(row.breaks, now, limit);
  if (counted && used.left === 0) throw new ConvexError(PRACTICE_WORDS.limit(limit));
  await setState(ctx, app, row, BREAKS[failure], {
    broken: { failure, at: now },
    ...(counted && { breaks: { day: used.day, count: used.used + 1 } }),
  });
  return { breaksLeft: counted ? used.left - 1 : used.left };
}

// The owner's Break button, after its confirmation sheet: the practice app fails the way they chose until turtl fixes
// it. turtl's ordinary watching notices; nothing here opens a case.
export const breakApp = mutation({
  args: { projectId: v.string(), failure: vPracticeFailure },
  returns: v.object({ breaksLeft: v.number() }),
  handler: async (ctx, { projectId, failure }) => {
    const app = await requireApp(ctx, appIdOf(ctx, projectId));
    return await breakPractice(ctx, app, await practiceRowOf(ctx, app), failure, true);
  },
});

// "Put it back": the practice app works again, with nothing switched. For a practice app the owner broke and turtl did
// not fix (its fixes were declined, or the case ended unresolved). Refused while a case on it is open.
export const mend = mutation({
  args: { projectId: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const app = await requireApp(ctx, appIdOf(ctx, projectId));
    const row = await practiceRowOf(ctx, app);
    if (await openCase(ctx, app._id)) throw new ConvexError(PRACTICE_WORDS.caseOpenMend);
    if (failureOf(switchesOf(row))) await setState(ctx, app, row, WORKING);
    return null;
  },
});

// For the review account's setup (review.ts): the operator's break, which the owner's daily allowance does not count,
// and the put-back that lets the monitor see a pass before it.
export const operatorBreak = internalMutation({
  args: { appId: v.id("apps"), failure: vPracticeFailure },
  returns: v.null(),
  handler: async (ctx, { appId, failure }) => {
    const app = await ctx.db.get(appId);
    const row = app?.practice ? await practiceRow(ctx, appId) : null;
    if (!app || !row) throw new Error(PRACTICE_WORDS.notPractice);
    await breakPractice(ctx, app, row, failure, false);
    return null;
  },
});

export const operatorMend = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.null(),
  handler: async (ctx, { appId }) => {
    const row = await practiceRow(ctx, appId);
    if (!row) throw new Error(PRACTICE_WORDS.notPractice);
    await ctx.db.patch(row._id, { ...WORKING, updatedAt: Date.now() });
    return null;
  },
});

export const openCaseOf = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.union(v.null(), v.object({ caseId: v.id("cases"), status: v.string() })),
  handler: async (ctx, { appId }) => {
    const row = await openCase(ctx, appId);
    return row ? { caseId: row._id, status: row.status } : null;
  },
});

export const practiceState = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.union(v.null(), v.object({ failure: v.union(v.null(), vPracticeFailure) })),
  handler: async (ctx, { appId }) => {
    const row = await practiceRow(ctx, appId);
    return row ? { failure: failureOf(switchesOf(row)) } : null;
  },
});
