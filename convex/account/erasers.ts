import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { RATE_LIMITS } from "../intake/rules";

// The deleting itself, for the lists in registry.ts. Every function here removes at most `budget` rows (and their
// files) and says whether any are left, so the job can call it again in the next batch. Each is safe to run twice: a
// second run finds nothing and reports done.

export type Progress = { removed: number; files: number; done: boolean };

const finished: Progress = { removed: 0, files: 0, done: true };
const unfinished: Progress = { removed: 0, files: 0, done: false };

// The registry names tables and indexes as data, so its reads go through this loose view of ctx.db.
type Range = { eq(field: string, value: unknown): Range; gte(field: string, value: unknown): Range; lt(field: string, value: unknown): Range };
type LooseQuery = { withIndex(index: string, range: (q: Range) => Range): { take(count: number): Promise<({ _id: string } & Record<string, unknown>)[]> } };
const loose = (ctx: MutationCtx, table: TableNames) => ctx.db.query(table) as unknown as LooseQuery;
const remove = (ctx: MutationCtx, id: string) => ctx.db.delete(id as Id<TableNames>);

/** Deletes a file in Convex storage. False when there was none (already deleted, or never stored). */
export async function deleteFile(ctx: MutationCtx, storageId: unknown): Promise<boolean> {
  const id = typeof storageId === "string" ? ctx.db.system.normalizeId("_storage", storageId) : null;
  if (!id || !(await ctx.db.system.get(id))) return false;
  await ctx.storage.delete(id);
  return true;
}

/** Rows of `table` whose index's first field equals `value`, a batch at a time. */
export async function eraseRows(
  ctx: MutationCtx,
  entry: { table: TableNames; index: string; field: string; file?: string },
  value: string,
  budget: number,
): Promise<Progress> {
  if (budget <= 0) return unfinished;
  const rows = await loose(ctx, entry.table).withIndex(entry.index, (q) => q.eq(entry.field, value)).take(budget + 1);
  let files = 0;
  for (const row of rows.slice(0, budget)) {
    if (entry.file && (await deleteFile(ctx, row[entry.file]))) files++;
    await remove(ctx, row._id);
  }
  return { removed: Math.min(rows.length, budget), files, done: rows.length <= budget };
}

/** One step of a list of erasers over the same target, in order, stopping when the budget runs out. */
export async function eraseInOrder(steps: ((budget: number) => Promise<Progress>)[], budget: number): Promise<Progress> {
  let removed = 0;
  let files = 0;
  for (const step of steps) {
    const progress = await step(budget - removed);
    removed += progress.removed;
    files += progress.files;
    if (!progress.done) return { removed, files, done: false };
  }
  return { removed, files, done: true };
}

/** The report form's rate-limit windows for one project (convex/intake/records.ts names them): per key,
 * "<limit>:<key id>", and per sender, "<limit>:<app id>:<sender>". The keys are read here, so this runs before
 * they are deleted. */
export async function eraseIntakeWindows(ctx: MutationCtx, appId: string, budget: number): Promise<Progress> {
  const app = ctx.db.normalizeId("apps", appId);
  if (!app) return finished;
  const keys = await ctx.db.query("intakeKeys").withIndex("by_app", (q) => q.eq("appId", app)).take(200);
  const exact = keys.flatMap((key) => RATE_LIMITS.filter((limit) => limit.name.startsWith("key")).map((limit) => `${limit.name}:${key._id}`));
  // Every bucket that starts with "<limit>:<app id>:". ":" sorts just before ";", so [prefix, "<limit>:<app id>;") holds them all.
  const prefixes = RATE_LIMITS.filter((limit) => !limit.name.startsWith("key")).map((limit) => `${limit.name}:${app}:`);
  const windows = loose(ctx, "intakeRateWindows");
  return await eraseInOrder(
    [
      ...exact.map((bucket) => async (left: number) => await eraseRows(ctx, { table: "intakeRateWindows", index: "by_bucket_and_window", field: "bucket" }, bucket, left)),
      ...prefixes.map((prefix) => async (left: number): Promise<Progress> => {
        if (left <= 0) return unfinished;
        const rows = await windows.withIndex("by_bucket_and_window", (q) => q.gte("bucket", prefix).lt("bucket", prefix.slice(0, -1) + ";")).take(left + 1);
        for (const row of rows.slice(0, left)) await remove(ctx, row._id);
        return { removed: Math.min(rows.length, left), files: 0, done: rows.length <= left };
      }),
    ],
    budget,
  );
}

/** Ends every session of the account now: a token the app still holds stops working at once (convex/access.ts reads
 * the session), and Convex Auth refuses to refresh an expired session. The rows are deleted later, by eraseSignIn. */
export async function expireSessions(ctx: MutationCtx, userId: Id<"users">, budget: number): Promise<Progress> {
  if (budget <= 0) return unfinished;
  const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(500);
  const live = sessions.filter((session) => session.expirationTime > 0);
  for (const session of live.slice(0, budget)) await ctx.db.patch(session._id, { expirationTime: 0 });
  return { removed: Math.min(live.length, budget), files: 0, done: live.length <= budget };
}

/** The rate-limit rows Convex Auth keys on a sign-in method: its id (wrong passwords) and its email (reset codes). */
async function eraseRateLimits(ctx: MutationCtx, identifiers: (string | undefined)[]): Promise<number> {
  let removed = 0;
  for (const identifier of new Set(identifiers.filter((value): value is string => !!value))) {
    for (const row of await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", identifier)).take(10)) {
      await ctx.db.delete(row._id);
      removed++;
    }
  }
  return removed;
}

/** Removes the account's ways to sign in (password, Apple, GitHub), with their reset codes, resets under way and rate limits, so
 * nobody can sign in to it again. The users row stays until the end of the job. */
export async function eraseSignInMethods(ctx: MutationCtx, userId: Id<"users">, budget: number): Promise<Progress> {
  if (budget <= 0) return unfinished;
  let removed = 0;
  const methods = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(20);
  for (const method of methods) {
    if (removed >= budget) return { removed, files: 0, done: false };
    for (const table of ["authVerificationCodes", "authPasswordResets"] as const) {
      const rows = await eraseRows(ctx, { table, index: "accountId", field: "accountId" }, method._id, budget - removed);
      removed += rows.removed;
      if (!rows.done) return { removed, files: 0, done: false };
    }
    removed += await eraseRateLimits(ctx, [method._id, method.provider === "password" ? method.providerAccountId : undefined]);
    await ctx.db.delete(method._id);
    removed++;
  }
  return { removed, files: 0, done: true };
}

/** The account's sign-in records, last of everything: sessions with their refresh tokens and verifiers, sign-in
 * methods, rate limits keyed on its email, and finally the users row. */
export async function eraseSignIn(ctx: MutationCtx, account: string, budget: number): Promise<Progress> {
  const userId = ctx.db.normalizeId("users", account);
  if (!userId) return finished;
  const user: Doc<"users"> | null = await ctx.db.get(userId);
  const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(20);
  const steps = [
    ...sessions.map((session) => async (left: number): Promise<Progress> => {
      const tokens = await eraseRows(ctx, { table: "authRefreshTokens", index: "sessionId", field: "sessionId" }, session._id, left);
      if (!tokens.done) return tokens;
      const verifiers = await eraseRows(ctx, { table: "authVerifiers", index: "sessionId", field: "sessionId" }, session._id, left - tokens.removed);
      if (!verifiers.done || left - tokens.removed - verifiers.removed <= 0) return { removed: tokens.removed + verifiers.removed, files: 0, done: false };
      await ctx.db.delete(session._id);
      return { removed: tokens.removed + verifiers.removed + 1, files: 0, done: true };
    }),
    async (left: number) => await eraseSignInMethods(ctx, userId, left),
  ];
  const progress = await eraseInOrder(steps, budget);
  // More sessions than one batch reads: come back for the rest before the users row goes.
  if (!progress.done || sessions.length === 20) return { ...progress, done: false };
  const emailLimits = await eraseRateLimits(ctx, [user?.email]);
  if (user) await ctx.db.delete(userId);
  return { removed: progress.removed + emailLimits + (user ? 1 : 0), files: 0, done: true };
}
