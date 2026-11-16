import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import type { Actor } from "./constants";

declare const process: { env: Record<string, string | undefined> };

// Who is calling, and is this project theirs. Every public function asks here, so the rule lives in one file;
// tests/access-coverage.test.mjs fails CI for a public function that does not.
//
// AUTH_REQUIRED on the deployment picks the mode:
// - unset: the single-owner demo. Every caller is the one owner, as before accounts existed, and owner
//   decisions are guarded by the owner passcode (convex/ownerPasscode.ts).
// - "true": accounts. A caller must be signed in, and reaches only the projects whose ownerId is their account
//   and what hangs off them. Owner decisions are authorised by being that owner; no passcode is asked for.
//
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

type AuthCtx = Pick<QueryCtx, "auth">;
type ReadCtx = Pick<QueryCtx, "auth" | "db">;
type AskCtx = Pick<ActionCtx, "runQuery">;

export function accessEnforced(): boolean {
  return process.env.AUTH_REQUIRED === "true";
}

/** The signed-in account's id, or null. Convex Auth writes "<users id>|<session id>" as the token's subject. A token
 * stays valid for up to an hour after its session ends (signed out elsewhere, or the account is being deleted), so
 * where there is a database the session must still be live. Actions have none; they ask through internal.access.*. */
export async function signedInAccount(ctx: AuthCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const [account, session] = identity.subject.split("|");
  // Only a subject naming a real session id is checked; one that names none (an admin's test identity) reads as before.
  const db = (ctx as Partial<ReadCtx>).db;
  const sessionId = db?.normalizeId && session ? db.normalizeId("authSessions", session) : null;
  if (db && sessionId) {
    const row = await db.get(sessionId);
    if (!row || row.expirationTime <= Date.now()) return null;
  }
  return account;
}

/** The account that owned records are filed under. With accounts on, throws unless someone is signed in. */
export async function requireAccount(ctx: AuthCtx): Promise<string> {
  if (!accessEnforced()) return SOLO_ACCOUNT;
  const account = await signedInAccount(ctx);
  if (!account) throw new ConvexError(SIGN_IN_REQUIRED);
  return account;
}

/** The same answer without throwing: null when accounts are on and nobody is signed in. */
export async function currentAccount(ctx: AuthCtx): Promise<string | null> {
  return accessEnforced() ? await signedInAccount(ctx) : SOLO_ACCOUNT;
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
  if (!devToolsEnabled()) throw new Error(message);
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

export const account = internalQuery({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await requireAccount(ctx),
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
