import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "../_generated/server";
import { mutation, query } from "../functions";
import { accessEnforced, canSeeApp, guardApp } from "../access";
import { requireOwnerPasscode } from "../ownerPasscode";
import { ceilingRefusal, intakeKeysPerProject } from "../spend/limits";

// A public intake key names one app in its customers' report form. It is not a secret: it ships inside
// the customer's app, and the endpoint's rate limits, not the key, stop abuse. The owner makes one in the project's
// Settings (Customer reports), sees it once, and can revoke it there; the list shows only when each was made and how
// it ends, so a key is copied from the moment it is made.

/** More live keys than any project holds (the cap with accounts on is intakeKeysPerProject); it bounds the list. */
const LIST_LIMIT = 50;

export async function issueKey(ctx: MutationCtx, appId: Id<"apps">) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const key = `tik_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  await ctx.db.insert("intakeKeys", { appId, key, createdAt: Date.now() });
  return key;
}

const activeKeys = (ctx: Pick<QueryCtx, "db">, appId: Id<"apps">) =>
  ctx.db.query("intakeKeys").withIndex("by_app_and_revoked", (q) => q.eq("appId", appId).eq("revokedAt", undefined)).take(LIST_LIMIT);

// The project's keys that still accept reports, newest first: when each was made and its last four characters.
export const forApp = query({
  args: { appId: v.id("apps") },
  returns: v.array(v.object({ id: v.id("intakeKeys"), createdAt: v.number(), ending: v.string() })),
  handler: async (ctx, { appId }) => {
    if (!(await canSeeApp(ctx, appId))) return [];
    return (await activeKeys(ctx, appId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({ id: row._id, createdAt: row.createdAt, ending: row.key.slice(-4) }));
  },
});

// Makes a new intake key for an app on the owner's behalf (in the demo, behind the owner passcode). This answer is the
// only time the whole key is shown.
export const issue = mutation({
  args: { appId: v.id("apps"), passcode: v.optional(v.string()) },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, { appId, passcode }) => {
    await guardApp(ctx, appId, "This app does not exist.");
    await requireOwnerPasscode(ctx, passcode);
    if (!(await ctx.db.get(appId))) throw new ConvexError("This app does not exist.");
    // Each live key carries its own report limits, so a project has at most so many at once (finding 7).
    const cap = intakeKeysPerProject();
    if (accessEnforced() && (await ctx.db.query("intakeKeys").withIndex("by_app_and_revoked", (q) => q.eq("appId", appId).eq("revokedAt", undefined)).take(cap)).length >= cap) {
      throw new ConvexError(ceilingRefusal.intakeKeys(cap));
    }
    return { key: await issueKey(ctx, appId) };
  },
});

// Stops a key from accepting reports, named by its id (from forApp) or, for the operator, by the key itself. Reports
// it already delivered stay.
export const revoke = mutation({
  args: { keyId: v.optional(v.string()), key: v.optional(v.string()), passcode: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { keyId, key, passcode }) => {
    const find = async () => {
      const id = keyId ? ctx.db.normalizeId("intakeKeys", keyId) : null;
      if (id) return await ctx.db.get(id);
      return key ? await ctx.db.query("intakeKeys").withIndex("by_key", (q) => q.eq("key", key)).unique() : null;
    };
    const owned = accessEnforced() ? await find() : null;
    await guardApp(ctx, owned?.appId, "This intake key does not exist.");
    await requireOwnerPasscode(ctx, passcode);
    const row = await find();
    if (!row) throw new ConvexError("This intake key does not exist.");
    if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return null;
  },
});
