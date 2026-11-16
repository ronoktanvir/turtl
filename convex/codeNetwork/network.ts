import { v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { query } from "../functions";
import type { Doc } from "../_generated/dataModel";
import { canSeeApp } from "../access";
import {
  vCodeChatScope,
  vNetCluster,
  vNetEdge,
  vNetNode,
  scopeKey,
  type ChatMessage,
  type CodeNetwork,
} from "./schema";

const HISTORY_LIMIT = 50;

const latest = (ctx: QueryCtx, projectId: string) =>
  ctx.db
    .query("codeNetworks")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .order("desc")
    .first();

const toMessage = (row: Doc<"codeChatMessages">): ChatMessage => ({
  id: row._id,
  role: row.role,
  text: row.text,
  at: row.at,
});

// The project's code network for the Investigate screen; null when none was built or seeded.
export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }): Promise<CodeNetwork | null> => {
    if (!(await canSeeApp(ctx, projectId))) return null;
    const row = await latest(ctx, projectId);
    if (!row) return null;
    return {
      projectId: row.projectId,
      generatedAt: row.generatedAt,
      clusters: row.clusters,
      nodes: row.nodes,
      edges: row.edges,
    };
  },
});

// The conversation in one scope, oldest first.
export const messages = query({
  args: { scope: vCodeChatScope },
  handler: async (ctx, { scope }): Promise<ChatMessage[]> => {
    if (!(await canSeeApp(ctx, scope.projectId))) return [];
    const rows = await ctx.db
      .query("codeChatMessages")
      .withIndex("by_project_scope_and_at", (q) =>
        q.eq("projectId", scope.projectId).eq("scopeKey", scopeKey(scope)),
      )
      .order("desc")
      .take(HISTORY_LIMIT);
    return rows.reverse().map(toMessage);
  },
});

export const stored = internalQuery({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => await latest(ctx, projectId),
});

export const recentMessages = internalQuery({
  args: { projectId: v.string(), scopeKey: v.string(), limit: v.number() },
  handler: async (ctx, args): Promise<ChatMessage[]> => {
    const rows = await ctx.db
      .query("codeChatMessages")
      .withIndex("by_project_scope_and_at", (q) =>
        q.eq("projectId", args.projectId).eq("scopeKey", args.scopeKey),
      )
      .order("desc")
      .take(args.limit);
    return rows.reverse().map(toMessage);
  },
});

export const addMessage = internalMutation({
  args: {
    projectId: v.string(),
    scopeKey: v.string(),
    role: v.union(v.literal("owner"), v.literal("turtl")),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<ChatMessage> => {
    const at = Date.now();
    const id = await ctx.db.insert("codeChatMessages", { ...args, at });
    return { id, role: args.role, text: args.text, at };
  },
});

// Replaces the project's network.
export async function replaceNetwork(ctx: MutationCtx, network: WithoutSystemFields<Doc<"codeNetworks">>) {
  const existing = await ctx.db
    .query("codeNetworks")
    .withIndex("by_project", (q) => q.eq("projectId", network.projectId))
    .collect();
  for (const row of existing) await ctx.db.delete(row._id);
  return await ctx.db.insert("codeNetworks", network);
}

export const store = internalMutation({
  args: {
    projectId: v.string(),
    repo: v.string(),
    ref: v.string(),
    namespace: v.string(),
    source: v.union(v.literal("seed"), v.literal("built")),
    generatedAt: v.number(),
    clusters: v.array(vNetCluster),
    nodes: v.array(vNetNode),
    edges: v.array(vNetEdge),
  },
  handler: async (ctx, args) => await replaceNetwork(ctx, args),
});
