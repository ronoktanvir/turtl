import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { requireOwnerPasscode } from "../ownerPasscode";

// A public intake key names one app in its customers' report form. It is not a secret: it ships inside
// the customer's app, and the endpoint's rate limits, not the key, stop abuse.
export async function issueKey(ctx: MutationCtx, appId: Id<"apps">) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const key = `tik_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  await ctx.db.insert("intakeKeys", { appId, key, createdAt: Date.now() });
  return key;
}

export const forApp = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) =>
    (await ctx.db.query("intakeKeys").withIndex("by_app", (q) => q.eq("appId", appId)).collect())
      .filter((row) => row.revokedAt === undefined)
      .map((row) => ({ key: row.key, createdAt: row.createdAt })),
});

// Registers a new intake key for an app on the owner's behalf, so it needs the owner passcode.
export const issue = mutation({
  args: { appId: v.id("apps"), passcode: v.optional(v.string()) },
  handler: async (ctx, { appId, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    if (!(await ctx.db.get(appId))) throw new ConvexError("This app does not exist.");
    return { key: await issueKey(ctx, appId) };
  },
});

// Stops a key from accepting reports. Reports it already delivered stay.
export const revoke = mutation({
  args: { key: v.string(), passcode: v.optional(v.string()) },
  handler: async (ctx, { key, passcode }) => {
    await requireOwnerPasscode(ctx, passcode);
    const row = await ctx.db.query("intakeKeys").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) throw new ConvexError("This intake key does not exist.");
    if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return null;
  },
});
