import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { NOT_AVAILABLE } from "../access";
import { vSecretKind, type SecretKind } from "./schema";
import { MANAGED_TOKEN } from "./words";

// The rows behind convex/secrets. Internal only: the public functions in project.ts and account.ts answer whether a
// secret is set and when, and nothing here is reachable from a client.

type Read = Pick<QueryCtx, "db">;

/** Bound into each seal (seal.ts), so a sealed value opens only for the project or account it was set for. */
export const contextOf = (kind: SecretKind, owner: string) => `turtl-secret:${kind}:${owner}`;

/** More rows than one slot ever holds; it bounds every read. */
const SLOT_SCAN = 10;

const projectRows = (ctx: Read, appId: Id<"apps">, kind: SecretKind) =>
  ctx.db.query("secrets").withIndex("by_app_and_kind", (q) => q.eq("appId", appId).eq("kind", kind)).take(SLOT_SCAN);

const accountRows = async (ctx: Read, account: string, kind: SecretKind) =>
  (await ctx.db.query("secrets").withIndex("by_account_and_kind", (q) => q.eq("account", account).eq("kind", kind)).take(SLOT_SCAN)).filter(
    (row) => row.appId === undefined,
  );

/** A project's secret, kept only while the account that set it still owns the project. */
export async function projectSecret(ctx: Read, appId: Id<"apps">, kind: SecretKind): Promise<Doc<"secrets"> | null> {
  const app = await ctx.db.get(appId);
  if (!app?.ownerId) return null;
  const rows = await projectRows(ctx, appId, kind);
  return rows.filter((row) => row.account === app.ownerId).sort((a, b) => b.setAt - a.setAt)[0] ?? null;
}

/** An account's own secret (not one of its projects'). */
export async function accountSecret(ctx: Read, account: string, kind: SecretKind): Promise<Doc<"secrets"> | null> {
  return (await accountRows(ctx, account, kind)).sort((a, b) => b.setAt - a.setAt)[0] ?? null;
}

/** Whose project a request is for, by project or by case. */
async function projectOf(ctx: Read, scope: { appId: string } | { caseId: string }): Promise<Doc<"apps"> | null> {
  if ("appId" in scope) {
    const appId = ctx.db.normalizeId("apps", scope.appId);
    return appId ? await ctx.db.get(appId) : null;
  }
  const caseId = ctx.db.normalizeId("cases", scope.caseId);
  const row = caseId ? await ctx.db.get(caseId) : null;
  return row ? await ctx.db.get(row.appId) : null;
}

/** Deletes every row in one slot: a project's secret of a kind, or an account's own secret of a kind. */
export async function clearSlot(ctx: Pick<MutationCtx, "db">, kind: SecretKind, owner: { appId: Id<"apps"> } | { account: string }): Promise<number> {
  const rows = "appId" in owner ? await projectRows(ctx, owner.appId, kind) : await accountRows(ctx, owner.account, kind);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

// Stores a sealed secret, replacing whatever the slot held. A project's secret is stored only for the account that
// owns the project now, so a guard passed a moment earlier cannot be raced by a change of owner or a deletion. A practice
// app's control token is turtl's own (managed.ts): only turtl stores it, and nothing an owner sends replaces it.
export const put = internalMutation({
  args: { kind: vSecretKind, account: v.string(), appId: v.optional(v.id("apps")), sealed: v.string(), keyId: v.string(), managed: v.optional(v.boolean()) },
  returns: v.object({ setAt: v.number() }),
  handler: async (ctx, { kind, account, appId, sealed, keyId, managed }) => {
    if (appId) {
      const app = await ctx.db.get(appId);
      if (!app || app.ownerId !== account) throw new ConvexError(NOT_AVAILABLE);
      if (Boolean(app.practice) !== Boolean(managed)) throw new ConvexError(app.practice ? MANAGED_TOKEN : NOT_AVAILABLE);
    } else if (managed) {
      throw new ConvexError(NOT_AVAILABLE);
    }
    await clearSlot(ctx, kind, appId ? { appId } : { account });
    const setAt = Date.now();
    await ctx.db.insert("secrets", { kind, account, ...(appId && { appId }), sealed, keyId, setAt });
    return { setAt };
  },
});

const vScope = v.union(v.object({ appId: v.string() }), v.object({ caseId: v.string() }), v.object({ account: v.string() }));

// The sealed form of one secret for the action about to send it, with the context it was sealed for. A control token
// is the project's own; a coding agent key belongs to the project's owner (or the account named).
export const sealedFor = internalQuery({
  args: { kind: vSecretKind, scope: vScope },
  returns: v.union(v.null(), v.object({ sealed: v.string(), keyId: v.string(), context: v.string() })),
  handler: async (ctx, { kind, scope }) => {
    let row: Doc<"secrets"> | null = null;
    if ("account" in scope) {
      row = kind === "coding_agent_key" && scope.account ? await accountSecret(ctx, scope.account, kind) : null;
    } else {
      const app = await projectOf(ctx, scope);
      if (app?.ownerId) row = kind === "control_token" ? await projectSecret(ctx, app._id, kind) : await accountSecret(ctx, app.ownerId, kind);
    }
    if (!row) return null;
    return { sealed: row.sealed, keyId: row.keyId, context: contextOf(kind, row.appId ?? row.account) };
  },
});
