import type { MutationCtx, QueryCtx } from "../_generated/server";

// Whether a password account has confirmed its email address: the one check convex/access.ts makes for it. The rest
// (the "check your email" screen's functions, the sweep, the operator's override) is in confirmation.ts. Kept apart,
// importing nothing from access.ts, so access.ts can call it.
//
// A password account made with accounts on gets an authUnconfirmed row in the same transaction that makes it (the
// afterUserCreatedOrUpdated callback in convex/auth.ts), and loses it only when its address is confirmed. Accounts
// that signed in with Apple or GitHub never get one. Accounts made before confirmation existed have none either, so
// they count as confirmed (convex/auth/README.md).

type Db = QueryCtx["db"];

/** The account's hold, while it has one. `account` is the users id every record is filed under. */
export const unconfirmedRow = (db: Db, account: string) => db.query("authUnconfirmed").withIndex("by_account", (q) => q.eq("account", account)).first();

/**
 * False only for a password account that has not confirmed its address yet. True for every other account, for a
 * subject that is not a user (an admin's test identity), and without a database: actions have none, and ask through
 * internal.access.*, whose queries do.
 */
export async function addressConfirmed(db: Db | undefined, account: string): Promise<boolean> {
  if (!db?.normalizeId?.("users", account)) return true;
  return (await unconfirmedRow(db, account)) === null;
}

/** The signed-in account while it is waiting to confirm its address, or null. Stricter than signedInAccount: the token
 * must name a live session of this very user. */
export async function unconfirmedAccount(ctx: Pick<QueryCtx, "auth" | "db">): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const [account, session] = identity.subject.split("|");
  const userId = account ? ctx.db.normalizeId("users", account) : null;
  const sessionId = session ? ctx.db.normalizeId("authSessions", session) : null;
  if (!userId || !sessionId) return null;
  const row = await ctx.db.get(sessionId);
  if (!row || row.userId !== userId || row.expirationTime <= Date.now()) return null;
  return (await unconfirmedRow(ctx.db, userId)) ? userId : null;
}

/** Called where Convex Auth makes a password account, in the same transaction: until its address is confirmed the
 * account reaches nothing. */
export async function holdUntilConfirmed(ctx: Pick<MutationCtx, "db">, account: string): Promise<void> {
  await ctx.db.insert("authUnconfirmed", { account, since: Date.now() });
}

/** The address is confirmed: the account may now do everything an account does. True when it was waiting. */
export async function markAddressConfirmed(ctx: Pick<MutationCtx, "db">, account: string): Promise<boolean> {
  const rows = await ctx.db.query("authUnconfirmed").withIndex("by_account", (q) => q.eq("account", account)).take(5);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length > 0;
}
