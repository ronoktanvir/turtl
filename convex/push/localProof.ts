import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

declare const process: { env: Record<string, string | undefined> };

// Seeds and reads for tests/push-local.integration.mjs, which proves this folder on a local Convex backend against
// a stand-in for Expo. Internal, and refused anywhere but a localhost backend with the dev tools switched on.

function requireLocalProof() {
  const host = new URL(process.env.CONVEX_CLOUD_URL ?? "https://invalid.example").hostname;
  if (process.env.DEV_TOOLS_ENABLED !== "true" || !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new Error("Push proofs require a localhost backend with the dev tools enabled.");
  }
}

export const seed = internalMutation({
  args: { name: v.string(), ownerId: v.optional(v.string()), repoUrl: v.optional(v.string()) },
  returns: v.object({ appId: v.id("apps"), caseId: v.id("cases") }),
  handler: async (ctx, { name, ownerId, repoUrl }) => {
    requireLocalProof();
    const appId = await ctx.db.insert("apps", { name, ...(ownerId ? { ownerId } : {}), ...(repoUrl ? { repoUrl } : {}) });
    const caseId = await ctx.db.insert("cases", {
      appId,
      title: "Customer wrote: my card 4242 was charged twice — TypeError at checkout.ts:42",
      impact: "Error: ECONNRESET in stripe.charge()",
      kind: "bug_report",
      raisedBy: "customer",
      status: "waiting_for_owner",
    });
    return { appId, caseId };
  },
});

export const snapshot = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.any(),
  handler: async (ctx, { caseId }) => {
    requireLocalProof();
    const sends = await ctx.db.query("pushSends").withIndex("by_case", (q) => q.eq("caseId", caseId)).take(10);
    const notices = await ctx.db.query("ownerNotices").withIndex("by_case_and_event", (q) => q.eq("caseId", caseId)).take(10);
    return { sends, notices };
  },
});

export const token = internalQuery({
  args: { token: v.string() },
  returns: v.any(),
  handler: async (ctx, { token }) => {
    requireLocalProof();
    return await ctx.db.query("pushTokens").withIndex("by_token", (q) => q.eq("token", token)).unique();
  },
});
