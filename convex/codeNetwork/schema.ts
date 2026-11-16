import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

// The Investigate screen's shapes, field for field as in the UI contract (section 6).
export const vNetCluster = v.object({
  id: v.string(),
  name: v.string(),
  summary: v.string(),
  health: v.optional(
    v.union(v.literal("affected"), v.literal("needs_you"), v.literal("working"), v.literal("clear")),
  ),
});
export const vNetNode = v.object({
  id: v.string(),
  clusterId: v.string(),
  label: v.string(),
  kind: v.union(
    v.literal("screen"),
    v.literal("module"),
    v.literal("service"),
    v.literal("data"),
    v.literal("external"),
  ),
  path: v.optional(v.string()),
  summary: v.string(),
  weight: v.optional(v.number()),
});
export const vNetEdge = v.object({
  from: v.string(),
  to: v.string(),
  relation: v.union(
    v.literal("imports"),
    v.literal("calls"),
    v.literal("reads"),
    v.literal("writes"),
    v.literal("depends_on"),
  ),
});
// The code network's part of the contract's ChatScope; the case scope belongs to the case chat.
export const vCodeChatScope = v.union(
  v.object({ kind: v.literal("project"), projectId: v.string() }),
  v.object({ kind: v.literal("cluster"), projectId: v.string(), clusterId: v.string() }),
  v.object({ kind: v.literal("node"), projectId: v.string(), nodeId: v.string() }),
);

export type NetCluster = Infer<typeof vNetCluster>;
export type NetNode = Infer<typeof vNetNode>;
export type NetEdge = Infer<typeof vNetEdge>;
export type CodeChatScope = Infer<typeof vCodeChatScope>;
export type CodeNetwork = {
  projectId: string;
  generatedAt: number;
  clusters: NetCluster[];
  nodes: NetNode[];
  edges: NetEdge[];
};
export type ChatMessage = { id: string; role: "owner" | "turtl"; text: string; at: number };

export const scopeKey = (scope: CodeChatScope): string =>
  scope.kind === "project" ? "project" : scope.kind === "cluster" ? `cluster:${scope.clusterId}` : `node:${scope.nodeId}`;

export const codeNamespace = (projectId: string): string =>
  `code_${projectId}`.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 100);

export const codeNetworkTables = {
  // One row per project: the latest network built from its repository, or the demo seed.
  codeNetworks: defineTable({
    projectId: v.string(),
    repo: v.string(),
    ref: v.string(),
    namespace: v.string(),
    source: v.union(v.literal("seed"), v.literal("built")),
    generatedAt: v.number(),
    clusters: v.array(vNetCluster),
    nodes: v.array(vNetNode),
    edges: v.array(vNetEdge),
  }).index("by_project", ["projectId"]),
  // Questions about the codebase, a cluster or a node, and turtl's answers.
  codeChatMessages: defineTable({
    projectId: v.string(),
    scopeKey: v.string(),
    role: v.union(v.literal("owner"), v.literal("turtl")),
    text: v.string(),
    at: v.number(),
  }).index("by_project_scope_and_at", ["projectId", "scopeKey", "at"]),
};
