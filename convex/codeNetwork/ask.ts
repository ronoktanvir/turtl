import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { searchChunks, type DocumentMatch } from "../supermemory";
import { respond } from "./openai";
import { scopeKey, vCodeChatScope, type ChatMessage, type CodeChatScope, type NetNode } from "./schema";

declare const process: { env: Record<string, string | undefined> };

const MAX_MESSAGE_LENGTH = 2000;
const MAX_OUTPUT_TOKENS = 1500;
const HISTORY_TURNS = 6;
const MAX_NEIGHBOURS = 20;

const SYSTEM_PROMPT = [
  "You are turtl, explaining how the owner's app works to an owner who cannot read code.",
  "Answer in plain words, in a few short sentences, and name the parts of the app by the plain names given below.",
  "Mention a file path only when the owner asks where something is.",
  "Use only the map of the code and the code excerpts below; never invent behaviour that is in neither. If they do not show the answer, say so.",
].join(" ");

export type AskResult =
  | { outcome: "answered"; message: ChatMessage; sources: string[] }
  | { outcome: "not_configured"; missing: string[] };

type Network = Doc<"codeNetworks">;

// What the owner is looking at, in words for the model, and which Supermemory documents to search.
function describeScope(network: Network, scope: CodeChatScope): { context: string; anyOf: DocumentMatch[] } {
  const clusterName = new Map(network.clusters.map((cluster) => [cluster.id, cluster.name]));
  const nodeById = new Map(network.nodes.map((node) => [node.id, node]));
  const parts = network.clusters.map((cluster) => `- ${cluster.name}: ${cluster.summary}`).join("\n");
  const overview = `The app's code (${network.repo}) has these parts:\n${parts}`;

  if (scope.kind === "project") {
    return { context: `${overview}\n\nThe owner is asking about the whole codebase.`, anyOf: [] };
  }

  if (scope.kind === "cluster") {
    const cluster = network.clusters.find((candidate) => candidate.id === scope.clusterId);
    if (!cluster) throw new Error(`Unknown cluster ${scope.clusterId} in project ${scope.projectId}.`);
    const members = network.nodes.filter((node) => node.clusterId === cluster.id);
    const memberIds = new Set(members.map((node) => node.id));
    const linked = new Set(
      network.edges
        .flatMap((edge) => (memberIds.has(edge.from) ? [edge.to] : memberIds.has(edge.to) ? [edge.from] : []))
        .map((id) => nodeById.get(id)?.clusterId)
        .filter((id): id is string => !!id && id !== cluster.id),
    );
    return {
      context: [
        overview,
        `The owner selected the part "${cluster.name}": ${cluster.summary}`,
        `Pieces in it:\n${members.map((node) => `- ${node.label} (${node.kind}${node.path ? `, ${node.path}` : ""}): ${node.summary}`).join("\n")}`,
        linked.size ? `It works with: ${[...linked].map((id) => clusterName.get(id) ?? id).join(", ")}.` : "",
      ].filter(Boolean).join("\n\n"),
      anyOf: [{ field: "clusterId", value: cluster.id }],
    };
  }

  const node = nodeById.get(scope.nodeId);
  if (!node) throw new Error(`Unknown node ${scope.nodeId} in project ${scope.projectId}.`);
  const links = network.edges.flatMap((edge): { relation: string; other: NetNode; outgoing: boolean }[] => {
    const otherId = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : undefined;
    const other = otherId ? nodeById.get(otherId) : undefined;
    return other ? [{ relation: edge.relation, other, outgoing: edge.from === node.id }] : [];
  });
  const documents = node.path
    ? [node.id]
    : links.flatMap(({ other }) => (other.path ? [other.id] : [])).slice(0, MAX_NEIGHBOURS);
  return {
    context: [
      overview,
      `The owner selected "${node.label}" (${node.kind}${node.path ? `, ${node.path}` : ""}) in the part "${clusterName.get(node.clusterId) ?? node.clusterId}": ${node.summary}`,
      links.length
        ? `Its connections:\n${links
            .map(({ relation, other, outgoing }) =>
              outgoing ? `- it ${relation} ${other.label}: ${other.summary}` : `- ${other.label} ${relation} it: ${other.summary}`,
            )
            .join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n"),
    anyOf: documents.length
      ? documents.map((value) => ({ field: "nodeId", value }))
      : [{ field: "clusterId", value: node.clusterId }],
  };
}

// Answers the owner's question about the whole codebase, a cluster or a node, from the stored network and the code in Supermemory.
export const ask = action({
  args: { scope: vCodeChatScope, message: v.string() },
  handler: async (ctx, { scope, message }): Promise<AskResult> => {
    const missing = [
      ...(process.env.CODE_NETWORK_CHAT_ENABLED === "true" ? [] : ["CODE_NETWORK_CHAT_ENABLED"]),
      ...["SUPERMEMORY_API_KEY", "OPENAI_API_KEY"].filter((name) => !process.env[name]),
    ];
    if (missing.length) return { outcome: "not_configured", missing };

    const text = message.trim();
    if (!text) throw new Error("message is empty.");
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`message is too long: ${text.length} characters, the limit is ${MAX_MESSAGE_LENGTH}.`);
    }
    const network = await ctx.runQuery(internal.codeNetwork.network.stored, { projectId: scope.projectId });
    if (!network) {
      throw new Error(`No code network is stored for project ${scope.projectId}. Build it with codeNetwork/build:build or load the seed with codeNetwork/dev:loadSeed.`);
    }
    const { context, anyOf } = describeScope(network, scope);
    const key = scopeKey(scope);
    const history = await ctx.runQuery(internal.codeNetwork.network.recentMessages, {
      projectId: scope.projectId,
      scopeKey: key,
      limit: HISTORY_TURNS,
    });
    await ctx.runMutation(internal.codeNetwork.network.addMessage, {
      projectId: scope.projectId,
      scopeKey: key,
      role: "owner",
      text,
    });

    const chunks = await searchChunks(network.namespace, text, { limit: 8, anyOf });
    const excerpts = chunks.length
      ? `Code excerpts found for this question:\n${chunks
          .map((chunk) => `--- ${typeof chunk.metadata.path === "string" ? chunk.metadata.path : "summary"}\n${chunk.text}`)
          .join("\n")}`
      : "No code excerpts were found for this question.";

    const { text: reply } = await respond({
      instructions: `${SYSTEM_PROMPT}\n\n${context}\n\n${excerpts}`,
      input: [
        ...history.map((turn) => ({ role: turn.role === "owner" ? ("user" as const) : ("assistant" as const), content: turn.text })),
        { role: "user" as const, content: text },
      ],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const answer = await ctx.runMutation(internal.codeNetwork.network.addMessage, {
      projectId: scope.projectId,
      scopeKey: key,
      role: "turtl",
      text: reply,
    });
    const sources = [
      ...new Set(chunks.flatMap((chunk) => (typeof chunk.metadata.path === "string" ? [chunk.metadata.path] : []))),
    ];
    return { outcome: "answered", message: answer, sources };
  },
});
