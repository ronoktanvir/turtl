import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { addressConfirmed, unconfirmedAccount } from "./auth/confirmed";
import type { Actor } from "./constants";

declare const process: { env: Record<string, string | undefined> };

// Who is calling, and is this project theirs. Every public function asks here, so the rule lives in one file;
// tests/access-coverage.test.mjs fails CI for a public function that does not.
//
// AUTH_REQUIRED on the deployment picks the mode, and fails closed:
// - unset, empty, or exactly "false": the single-owner demo. Every caller is the one owner, as before accounts
//   existed, and owner decisions are guarded by the owner passcode (convex/ownerPasscode.ts). The demo makes no
//   accounts, and refuses to serve a deployment that holds any (refuseDemoWithAccounts): one that served accounts and
//   then lost the variable closes, instead of handing every account's projects to anyone.
// - anything else: accounts. "true", and also "TRUE", "1", " true" or a typo, each of which meant to turn them on.
//   A caller must be signed in, and reaches only the projects whose ownerId is their account and what hangs off
//   them. Owner decisions are authorised by being that owner; no passcode is asked for.
//
// Every public function is made with the builders in convex/functions.ts, which run refuseDemoWithAccounts first.
// Identity does not travel with ctx.scheduler or a cron: check at the public function, then pass ids on.
//
// Two families of checks:
// - visible* and require* load the row and treat a missing one as "not available" in both modes. New public
//   functions use these.
// - can* and guard* are for the functions that predate accounts. With AUTH_REQUIRED unset they do nothing and
//   read nothing, so the demo keeps its exact results and error sentences. With accounts on they refuse with
//   the sentence the function already used for "not found", so another account's row reads exactly like a
//   row that does not exist.

/** The account the single-owner demo files everything under. Equal to SOLO_OWNER.identity in convex/decisions.ts. */
export const SOLO_ACCOUNT = "solo-owner";

export const SIGN_IN_REQUIRED = "Sign in to continue.";
/** One message for "does not exist" and "belongs to someone else", so an id cannot be probed. */
export const NOT_AVAILABLE = "That project is not available on this account.";
export const DEV_TOOLS_DISABLED = "Dev tools are disabled on this deployment.";
export const BOOKING_DEMO_CLOSED = "The booking demo does not run on this deployment.";

type DbCtx = Pick<QueryCtx, "db">;
type ReadCtx = Pick<QueryCtx, "auth" | "db">;
type AskCtx = Pick<ActionCtx, "runQuery">;

/** Accounts mode, unless AUTH_REQUIRED is unset, empty, or exactly "false". */
export function accessEnforced(): boolean {
  const value = process.env.AUTH_REQUIRED;
  return value !== undefined && value !== "" && value !== "false";
}

// The single-owner demo on a deployment that holds accounts is closed: nothing serves or acts in the demo's terms.
// Every public function refuses (convex/functions.ts), and so do the paths that run without a caller: the monitor's
// cron, customer reports, the consent gate for every outbound call, GitHub's callback and webhook, GitHub tokens, the
// owners' apps, the runner and push delivery (each says where it asks). The monitor's cron writes the one log line.

/** What the person sees. The backend log says why. */
export const UNAVAILABLE = "turtl is unavailable right now. Please try again later.";
const DEMO_WITH_ACCOUNTS =
  'turtl is closed: AUTH_REQUIRED is unset, empty or "false", which makes this deployment the single-owner demo, but it ' +
  "holds accounts (a sign-in, a user, or a project another account owns), and the demo would hand every account's " +
  "projects to anyone. Every public function refuses, and nothing runs in the demo's terms: no check, no customer " +
  "report, no outbound call, no GitHub change, no step of a case. Set AUTH_REQUIRED=true to serve the accounts again.";
/** The log line again at most this often while the deployment stays closed. */
const CLOSED_LOG_EVERY_MS = 24 * 60 * 60_000;

/** Whether this is the single-owner demo on a deployment that holds accounts: any sign-in row, any user, or any
 * project whose owner is not the demo's one owner. With accounts on: false, and nothing is read. In the demo: four
 * reads of at most one row each, which on a working demo find nothing. */
export async function demoHoldsAccounts(ctx: DbCtx): Promise<boolean> {
  if (accessEnforced()) return false;
  const { db } = ctx;
  if ((await db.query("authAccounts").first()) !== null || (await db.query("users").first()) !== null) return true;
  // Owners sort as text, so another account's id sorts after the demo's own or before it; a project with no owner
  // sorts first of all, so the last one before the demo's tells which.
  if ((await db.query("apps").withIndex("by_owner", (q) => q.gt("ownerId", SOLO_ACCOUNT)).first()) !== null) return true;
  const before = await db.query("apps").withIndex("by_owner", (q) => q.lt("ownerId", SOLO_ACCOUNT)).order("desc").first();
  return before !== null && before.ownerId !== undefined;
}

/** The same from an action, through one internal query; with accounts on it asks nothing. */
export async function demoHoldsAccountsInAction(ctx: AskCtx): Promise<boolean> {
  return !accessEnforced() && (await ctx.runQuery(internal.access.demoClosed, {}));
}

/** Refuses when this is the single-owner demo and the deployment holds accounts (demoHoldsAccounts). With accounts on:
 * nothing, no read. convex/functions.ts runs it before every public query and mutation. It writes no log line of its
 * own: a refused call can save nothing, so the monitor's cron writes the one line (noteClosedDemo). */
export async function refuseDemoWithAccounts(ctx: DbCtx): Promise<void> {
  if (await demoHoldsAccounts(ctx)) throw new ConvexError(UNAVAILABLE);
}

/** The same before every public action, which has no database: one internal query in the demo, nothing with accounts on. */
export async function refuseDemoWithAccountsInAction(ctx: AskCtx): Promise<void> {
  if (!accessEnforced()) await ctx.runQuery(internal.access.demoOpen, {});
}

export const NO_SIGN_IN = "This turtl has no accounts, so there is nothing to sign in to.";

/** For Convex Auth's callback inside the mutation that makes or updates an account's user (convex/auth.ts). The demo
 * makes none: anyone may call sign-in, and a single account closes the demo (refuseDemoWithAccounts). */
export function refuseSignInToDemo(): void {
  if (!accessEnforced()) throw new ConvexError(NO_SIGN_IN);
}

/** The context's database, which checking a session needs. An action has none and asks through internal.access.*;
 * a helper here that is handed an action's context refuses, rather than skip the session check. */
function databaseOf(ctx: Partial<DbCtx>): DbCtx["db"] {
  if (!ctx.db) throw new Error("convex/access.ts needs the database to check the session. From an action, ask through ctx.runQuery(internal.access.account, {}).");
  return ctx.db;
}

/** The signed-in account's id, or null. Convex Auth writes "<users id>|<session id>" as the token's subject. A token
 * stays valid for up to an hour after its session ends (signed out elsewhere, or the account is being deleted), so
 * the session must still be live. Actions have no database; they ask through internal.access.*. */
export async function signedInAccount(ctx: ReadCtx): Promise<string | null> {
  const db = databaseOf(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const [account, session] = identity.subject.split("|");
  // Only a subject naming a real session id is checked; one that names none (an admin's test identity) reads as before.
  const sessionId = session ? db.normalizeId("authSessions", session) : null;
  if (sessionId && !(await sessionLive({ db }, sessionId))) return null;
  // Email confirmation, checked here and nowhere else (see "email confirmation" at the end of this file).
  if (accessEnforced() && !(await addressConfirmed(db, account))) return null;
  return account;
}

/** Whether a Convex Auth session is still live: its row is there (signing out, a password reset and account deletion
 * delete it) and it has not run out. */
export async function sessionLive(ctx: DbCtx, sessionId: Id<"authSessions">): Promise<boolean> {
  const row = await ctx.db.get(sessionId);
  return !!row && row.expirationTime > Date.now();
}

/** The session the caller's token names. Convex Auth's tokens always name one; an identity the operator's admin key
 * stands for may name none, and then this is null. Ask after requireAccount, which has checked the session is live. */
export async function callerSession(ctx: ReadCtx): Promise<Id<"authSessions"> | null> {
  const db = databaseOf(ctx);
  const session = (await ctx.auth.getUserIdentity())?.subject.split("|")[1];
  return session ? db.normalizeId("authSessions", session) : null;
}

/** The demo's one owner, once the deployment is known to hold no account. These two answers are what everything else
 * about the caller builds on, so they check it too, for a function not made with convex/functions.ts. */
async function soloAccount(ctx: Partial<DbCtx>): Promise<string> {
  await refuseDemoWithAccounts({ db: databaseOf(ctx) });
  return SOLO_ACCOUNT;
}

/** The account that owned records are filed under. With accounts on, throws unless someone is signed in with a live
 * session, which needs the database: an action asks through internal.access.account instead. */
export async function requireAccount(ctx: ReadCtx): Promise<string> {
  if (!accessEnforced()) return await soloAccount(ctx);
  const account = await signedInAccount(ctx);
  if (!account) throw new ConvexError(SIGN_IN_REQUIRED);
  return account;
}

/** The same answer without throwing: null when accounts are on and nobody is signed in. */
export async function currentAccount(ctx: ReadCtx): Promise<string | null> {
  return accessEnforced() ? await signedInAccount(ctx) : await soloAccount(ctx);
}

export function ownsApp(app: Pick<Doc<"apps">, "ownerId">, account: string): boolean {
  return !accessEnforced() || app.ownerId === account;
}

/** What an owner decision records as its actor: the account. The demo's account is SOLO_ACCOUNT, so there it is SOLO_OWNER. */
export function ownerActor(account: string): Actor {
  return { kind: "owner", identity: account };
}

/** For mutations and actions: the project, or a refusal. */
export async function requireApp(ctx: ReadCtx, appId: Id<"apps">): Promise<Doc<"apps">> {
  const account = await requireAccount(ctx);
  const app = await ctx.db.get(appId);
  if (!app || !ownsApp(app, account)) throw new ConvexError(NOT_AVAILABLE);
  return app;
}

export async function requireCase(ctx: ReadCtx, caseId: Id<"cases">): Promise<{ case: Doc<"cases">; app: Doc<"apps">; account: string }> {
  const account = await requireAccount(ctx);
  const row = await ctx.db.get(caseId);
  const app = row ? await ctx.db.get(row.appId) : null;
  if (!row || !app || !ownsApp(app, account)) throw new ConvexError(NOT_AVAILABLE);
  return { case: row, app, account };
}

/** For queries: the project when the caller may see it, otherwise null, so a screen shows "not found" and not an error. */
export async function visibleApp(ctx: ReadCtx, appId: Id<"apps">): Promise<Doc<"apps"> | null> {
  const account = await currentAccount(ctx);
  const app = account ? await ctx.db.get(appId) : null;
  return app && account && ownsApp(app, account) ? app : null;
}

export async function visibleCase(ctx: ReadCtx, caseId: Id<"cases">): Promise<{ case: Doc<"cases">; app: Doc<"apps"> } | null> {
  const row = await ctx.db.get(caseId);
  const app = row ? await visibleApp(ctx, row.appId) : null;
  return row && app ? { case: row, app } : null;
}

/** More projects than one owner will have; it bounds the read. */
export const MAX_PROJECTS = 500;
/** The newest cases a project shows on a list. Older ones stay reachable by id. */
export const MAX_CASES_PER_PROJECT = 200;

/** Every project the caller may see. */
export async function visibleApps(ctx: ReadCtx): Promise<Doc<"apps">[]> {
  if (!accessEnforced()) return await ctx.db.query("apps").take(MAX_PROJECTS);
  const account = await signedInAccount(ctx);
  if (!account) return [];
  return await ctx.db.query("apps").withIndex("by_owner", (q) => q.eq("ownerId", account)).take(MAX_PROJECTS);
}

/** One project's newest cases, newest first, through the by_app index. The caller has already checked the project. */
export async function projectCases(ctx: ReadCtx, appId: Id<"apps">): Promise<Doc<"cases">[]> {
  return await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", appId)).order("desc").take(MAX_CASES_PER_PROJECT);
}

/** The newest cases of every project the caller may see, newest first. Functions that predate accounts keep their
 * demo read and call this only with accounts on. */
export async function visibleCases(ctx: ReadCtx): Promise<Doc<"cases">[]> {
  const perProject = await Promise.all((await visibleApps(ctx)).map((app) => projectCases(ctx, app._id)));
  return perProject.flat().sort((a, b) => b._creationTime - a._creationTime);
}

// Guards for the functions that predate accounts (see the top of this file). Ids may be an Id or the text of one,
// as the screens send them.

/** Rows that hang off a project, through their appId or their case. */
type ProjectRowTable = "ownerPreferences" | "preferenceSuggestions" | "permissions" | "recoveryMemories" | "structuralFindings" | "agentRuns" | "proposals";

async function ownerOfApp(ctx: ReadCtx, appId: Id<"apps"> | null | undefined): Promise<string | null> {
  const app = appId ? await ctx.db.get(appId) : null;
  return app?.ownerId ?? null;
}

async function appOfCase(ctx: ReadCtx, caseId: string | null | undefined): Promise<Id<"apps"> | null> {
  const id = caseId ? ctx.db.normalizeId("cases", caseId) : null;
  return (id && (await ctx.db.get(id))?.appId) || null;
}

async function appOfRow(ctx: ReadCtx, table: ProjectRowTable, id: string | null | undefined): Promise<Id<"apps"> | null> {
  const rowId = id ? ctx.db.normalizeId(table, id) : null;
  const row: { appId?: Id<"apps">; caseId?: Id<"cases"> } | null = rowId ? await ctx.db.get(rowId) : null;
  if (!row) return null;
  return row.appId ?? (await appOfCase(ctx, row.caseId));
}

async function guardProject(ctx: ReadCtx, appId: Id<"apps"> | null, refusal: string): Promise<string> {
  const account = await requireAccount(ctx);
  if ((await ownerOfApp(ctx, appId)) !== account) throw new ConvexError(refusal);
  return account;
}

/** For a write on a project. Returns the account to record. Demo: does nothing and returns SOLO_ACCOUNT. */
export async function guardApp(ctx: ReadCtx, appId: string | null | undefined, refusal = NOT_AVAILABLE): Promise<string> {
  if (!accessEnforced()) return SOLO_ACCOUNT;
  return await guardProject(ctx, appId ? ctx.db.normalizeId("apps", appId) : null, refusal);
}

/** For a write on a case: its project must be the caller's. */
export async function guardCase(ctx: ReadCtx, caseId: string | null | undefined, refusal = NOT_AVAILABLE): Promise<string> {
  if (!accessEnforced()) return SOLO_ACCOUNT;
  return await guardProject(ctx, await appOfCase(ctx, caseId), refusal);
}

/** For a write on a row that hangs off a project (a preference, a permission, a finding, a proposal...). */
export async function guardRow(ctx: ReadCtx, table: ProjectRowTable, id: string | null | undefined, refusal = NOT_AVAILABLE): Promise<string> {
  if (!accessEnforced()) return SOLO_ACCOUNT;
  return await guardProject(ctx, await appOfRow(ctx, table, id), refusal);
}

/** For a query on a project: may the caller see it? Demo: yes, without reading anything. */
export async function canSeeApp(ctx: ReadCtx, appId: string | null | undefined): Promise<boolean> {
  if (!accessEnforced()) return true;
  const account = await signedInAccount(ctx);
  return !!account && (await ownerOfApp(ctx, appId ? ctx.db.normalizeId("apps", appId) : null)) === account;
}

/** For a query on a case: is its project the caller's? Demo: yes, without reading anything. */
export async function canSeeCase(ctx: ReadCtx, caseId: string | null | undefined): Promise<boolean> {
  if (!accessEnforced()) return true;
  const account = await signedInAccount(ctx);
  return !!account && (await ownerOfApp(ctx, await appOfCase(ctx, caseId))) === account;
}

// Actions have no database. They ask through these, and the caller's identity carries into ctx.runQuery.

/** guardApp for an action. Demo: no query at all. */
export async function guardAppInAction(ctx: AskCtx, appId: string, refusal?: string): Promise<string> {
  if (!accessEnforced()) return SOLO_ACCOUNT;
  return await ctx.runQuery(internal.access.appGuard, { appId, ...(refusal !== undefined && { refusal }) });
}

/** guardCase for an action. Demo: no query at all. */
export async function guardCaseInAction(ctx: AskCtx, caseId: string, refusal?: string): Promise<string> {
  if (!accessEnforced()) return SOLO_ACCOUNT;
  return await ctx.runQuery(internal.access.caseGuard, { caseId, ...(refusal !== undefined && { refusal }) });
}

// Switches that close whole groups of functions in accounts mode.

/** The dev tools functions (dev.ts modules and the dev entries elsewhere) open only on a demo deployment with
 * DEV_TOOLS_ENABLED=true. Accounts mode keeps them closed whatever the flag says. */
export function devToolsEnabled(): boolean {
  return process.env.DEV_TOOLS_ENABLED === "true" && !accessEnforced();
}

export function requireDevTools(message = DEV_TOOLS_DISABLED): void {
  if (!devToolsEnabled()) throw new ConvexError(message);
}

/** The booking demo (convex/bookingDemo) shares a deployment with turtl only as a hosting shortcut, and its
 * customer functions take no account. The demo serves them as before. With accounts on, a deployment serves them
 * only when it hosts the booking demo, which its control hash says; production never sets that hash
 * (release/backend-env.mjs), so there they refuse. */
export function hostsBookingDemo(): boolean {
  return !accessEnforced() || /^[0-9a-f]{64}$/.test(process.env.PROTECTED_APP_CONTROL_SECRET_SHA256 ?? "");
}

export function requireBookingDemo(): void {
  if (!hostsBookingDemo()) throw new ConvexError(BOOKING_DEMO_CLOSED);
}

/** How an action asks who is calling: here the session is checked against the database, which an action has not. */
export const account = internalQuery({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await requireAccount(ctx),
});

/** refuseDemoWithAccountsInAction's read. */
export const demoOpen = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await refuseDemoWithAccounts(ctx);
    return null;
  },
});

/** demoHoldsAccountsInAction's read. */
export const demoClosed = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await demoHoldsAccounts(ctx),
});

/** For the monitor's cron, every minute: whether the demo is closed, writing the reason to the backend log when it is
 * first seen and then at most once a day while it lasts. Returns when the line was last written. */
export const noteClosedDemo = internalMutation({
  args: {},
  returns: v.object({ closed: v.boolean(), loggedAt: v.union(v.number(), v.null()) }),
  handler: async (ctx) => {
    if (!(await demoHoldsAccounts(ctx))) return { closed: false, loggedAt: null };
    const now = Date.now();
    const notice = await ctx.db.query("closedDemoNotices").first();
    if (notice && now - notice.loggedAt < CLOSED_LOG_EVERY_MS) return { closed: true, loggedAt: notice.loggedAt };
    console.error(DEMO_WITH_ACCOUNTS);
    if (notice) await ctx.db.patch(notice._id, { loggedAt: now });
    else await ctx.db.insert("closedDemoNotices", { loggedAt: now });
    return { closed: true, loggedAt: now };
  },
});

export const app = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.string(),
  handler: async (ctx, { appId }) => {
    await requireApp(ctx, appId);
    return await requireAccount(ctx);
  },
});

export const caseAccess = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({ account: v.string(), appId: v.id("apps") }),
  handler: async (ctx, { caseId }) => {
    const found = await requireCase(ctx, caseId);
    return { account: found.account, appId: found.app._id };
  },
});

export const appGuard = internalQuery({
  args: { appId: v.string(), refusal: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, { appId, refusal }) => await guardApp(ctx, appId, refusal),
});

export const caseGuard = internalQuery({
  args: { caseId: v.string(), refusal: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, { caseId, refusal }) => await guardCase(ctx, caseId, refusal),
});

// ---------------------------------------------------------------------------------------------- email confirmation
// With accounts on, a password account must confirm its email address before it reaches anything (convex/auth/
// confirmation.ts). Until then signedInAccount reads it as signed out, so every check above refuses it: it can make no
// project, connect no GitHub, store no secret, give no AI permission and so spend nothing. Accounts made with Apple or
// GitHub count as confirmed. Only the "check your email" screen's functions reach an unconfirmed account, through these.

/** The signed-in account while it still has to confirm its email address, or null: signed out, confirmed, or the demo. */
export async function pendingAccount(ctx: ReadCtx): Promise<string | null> {
  return accessEnforced() ? await unconfirmedAccount(ctx) : null;
}

/** pendingAccount for an action. */
export const pending = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => await pendingAccount(ctx),
});
