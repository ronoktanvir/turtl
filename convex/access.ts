import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";

declare const process: { env: Record<string, string | undefined> };

// Who is calling, and is this project theirs. Every public function asks here, so the rule lives in one file.
//
// AUTH_REQUIRED on the deployment picks the mode:
// - unset: the single-owner demo. Every caller is the one owner, as before accounts existed, and owner
//   decisions are guarded by the owner passcode (convex/ownerPasscode.ts).
// - "true": accounts. A caller must be signed in, and reaches only the projects whose ownerId is their account.
//
// Identity does not travel with ctx.scheduler or a cron: check at the public function, then pass ids on.

/** The account the single-owner demo files everything under. Equal to SOLO_OWNER.identity in convex/decisions.ts. */
export const SOLO_ACCOUNT = "solo-owner";

export const SIGN_IN_REQUIRED = "Sign in to continue.";
/** One message for "does not exist" and "belongs to someone else", so an id cannot be probed. */
export const NOT_AVAILABLE = "That project is not available on this account.";

type AuthCtx = Pick<QueryCtx, "auth">;
type ReadCtx = Pick<QueryCtx, "auth" | "db">;

export function accessEnforced(): boolean {
  return process.env.AUTH_REQUIRED === "true";
}

/** The signed-in account's id, or null. Convex Auth writes "<users id>|<session id>" as the token's subject. */
export async function signedInAccount(ctx: AuthCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? identity.subject.split("|")[0] : null;
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
const MAX_PROJECTS = 500;

/** Every project the caller may see. */
export async function visibleApps(ctx: ReadCtx): Promise<Doc<"apps">[]> {
  if (!accessEnforced()) return await ctx.db.query("apps").take(MAX_PROJECTS);
  const account = await signedInAccount(ctx);
  if (!account) return [];
  return await ctx.db.query("apps").withIndex("by_owner", (q) => q.eq("ownerId", account)).take(MAX_PROJECTS);
}

// Actions have no database. They ask through these, and the caller's identity carries into ctx.runQuery.

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
