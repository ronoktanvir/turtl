import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { PROVIDER_KEYS } from "../routing/configs";
import { vCouncilMember } from "./schema";

declare const process: { env: Record<string, string | undefined> };

export type CouncilMember = Infer<typeof vCouncilMember>;

// The server default: three distinct OpenAI models now; another lab's model joins as soon as its key is set.
export const DEFAULT_MEMBERS: CouncilMember[] = [
  { provider: "openai", model: "gpt-6.1-sol", reasoning: "medium" },
  { provider: "openai", model: "gpt-5.5", reasoning: "medium" },
  { provider: "openai", model: "gpt-6.1-terra", reasoning: "medium" },
  { provider: "anthropic", model: "claude-sonnet-4-5" },
  { provider: "google", model: "gemini-2.5-pro" },
];
export const DEFAULT_CONSOLIDATOR: CouncilMember = { provider: "openai", model: "gpt-6.1-sol", reasoning: "medium" };
export const DEFAULT_MAX_COST_USD = 0.5;

export const NOTICE =
  "Several models read the same evidence on their own. Agreement between them is not proof: they can share the same missing evidence. Nothing here was verified, and it approves nothing.";

export const resolve = internalQuery({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const row = await ctx.db.query("councilSettings").withIndex("by_app", (q) => q.eq("appId", appId)).unique();
    return {
      source: row ? ("app" as const) : ("server_default" as const),
      members: row?.members ?? DEFAULT_MEMBERS,
      consolidator: row?.consolidator ?? DEFAULT_CONSOLIDATOR,
      maxCostUsd: row?.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    };
  },
});

// Read-only: who sits on an app's council and which members can run with the keys this deployment has.
export const forApp = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const row = await ctx.db.query("councilSettings").withIndex("by_app", (q) => q.eq("appId", appId)).unique();
    const members = row?.members ?? DEFAULT_MEMBERS;
    return {
      source: row ? ("app" as const) : ("server_default" as const),
      maxCostUsd: row?.maxCostUsd ?? DEFAULT_MAX_COST_USD,
      members: members.map((member) => ({ ...member, keyName: PROVIDER_KEYS[member.provider] })),
    };
  },
});

// No owner-facing control sets this yet (the gear sheet has no model picker by contract); run it from the dashboard
// or CLI. Omitted fields keep their current value.
export const set = internalMutation({
  args: {
    appId: v.id("apps"),
    members: v.optional(v.array(vCouncilMember)),
    consolidator: v.optional(vCouncilMember),
    maxCostUsd: v.optional(v.number()),
  },
  handler: async (ctx, { appId, members, consolidator, maxCostUsd }) => {
    if (!(await ctx.db.get(appId))) throw new ConvexError("This app does not exist.");
    if (members && new Set(members.map((m) => `${m.provider}/${m.model}`)).size !== members.length) {
      throw new ConvexError("Each council member must be a distinct model.");
    }
    if (members && members.length < 2) throw new ConvexError("A council needs at least two models.");
    if (maxCostUsd !== undefined && !(maxCostUsd > 0 && maxCostUsd <= 5)) throw new ConvexError("Set a cost limit above $0 and at most $5.");
    const row = await ctx.db.query("councilSettings").withIndex("by_app", (q) => q.eq("appId", appId)).unique();
    const next = {
      members: members ?? row?.members ?? DEFAULT_MEMBERS,
      consolidator: consolidator ?? row?.consolidator ?? DEFAULT_CONSOLIDATOR,
      maxCostUsd: maxCostUsd ?? row?.maxCostUsd ?? DEFAULT_MAX_COST_USD,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert("councilSettings", { appId, ...next });
    return null;
  },
});

export const keyIsSet = (member: CouncilMember) => Boolean(process.env[PROVIDER_KEYS[member.provider]]);
