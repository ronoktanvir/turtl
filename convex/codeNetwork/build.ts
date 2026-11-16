import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { addDocuments, type CodeDocument } from "../supermemory";
import {
  buildGraph,
  fillClusters,
  isSourcePath,
  lineCount,
  type GraphEdge,
  type GraphNode,
  type SourceFile,
} from "./graph";
import { respond, type ModelUsage } from "./openai";
import { codeNamespace, type NetCluster, type NetNode } from "./schema";

declare const process: { env: Record<string, string | undefined> };

const MAX_FILES = 200;
const MAX_FILE_BYTES = 200_000;
const FETCH_CONCURRENCY = 10;
const DIGEST_BUDGET = 240_000;
const EXCERPT_CHARS = 2500;
const DOCUMENT_CHARS = 30_000;
const MODEL_OUTPUT_TOKENS = 16_000;

const CLUSTER_PROMPT = [
  "You map a software repository for its owner, who cannot read code.",
  "Group the pieces below into 4 to 9 parts the owner would recognise by what the app does (for example \"Booking\", \"Recommendations\", \"Payments\", \"Sign-in\"), not by folder.",
  "Keep the parts balanced: no part should hold more than about a fifth of the pieces, so split a broad area into the separate jobs an owner would recognise.",
  "For each part give a short id in lowercase-with-hyphens, a plain name of one to three words, and one plain sentence of at most 30 words on what happens there.",
  "For every piece give its id exactly as listed, the id of its part, a plain label of two to four words, and one plain sentence of at most 25 words on what happens there.",
  "Do not use code words such as function, mutation, handler, schema or module. Never describe behaviour the code does not show. Every piece appears exactly once.",
].join(" ");

const CLUSTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clusters", "nodes"],
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "summary"],
        properties: { id: { type: "string" }, name: { type: "string" }, summary: { type: "string" } },
      },
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "clusterId", "label", "summary"],
        properties: {
          id: { type: "string" },
          clusterId: { type: "string" },
          label: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
};

type Labels = {
  clusters: NetCluster[];
  nodes: Map<string, { clusterId: string; label: string; summary: string }>;
};

export type BuildResult =
  | {
      outcome: "built";
      projectId: string;
      repo: string;
      ref: string;
      namespace: string;
      files: number;
      clusters: number;
      nodes: number;
      edges: number;
      documents: { count: number; failed: number };
      model: ModelUsage | null;
      timings: { githubMs: number; modelMs: number; supermemoryMs: number; totalMs: number };
    }
  | { outcome: "not_configured"; missing: string[] }
  | { outcome: "failed"; reason: string };

async function github(path: string, token: string | undefined): Promise<Response> {
  return await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "turtl-code-network",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function fetchRepository(
  repo: string,
  ref: string,
  token: string | undefined,
): Promise<{ sha: string; files: SourceFile[] } | { reason: string }> {
  const commit = await github(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, token);
  if (!commit.ok) {
    return {
      reason: `GitHub could not find ${repo} at ${ref} (${commit.status}).${token ? "" : " For a private repository set GITHUB_TOKEN."}`,
    };
  }
  const sha = ((await commit.json()) as { sha: string }).sha;
  const tree = await github(`/repos/${repo}/git/trees/${sha}?recursive=1`, token);
  if (!tree.ok) return { reason: `GitHub did not return the file list of ${repo} (${tree.status}).` };
  const entries = ((await tree.json()) as { tree: { path: string; type: string; size?: number }[] }).tree
    .filter((entry) => entry.type === "blob" && isSourcePath(entry.path) && (entry.size ?? 0) <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);
  const files: SourceFile[] = [];
  for (let start = 0; start < entries.length; start += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      entries.slice(start, start + FETCH_CONCURRENCY).map(async (entry) => {
        const response = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${entry.path}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return response.ok ? { path: entry.path, content: await response.text() } : null;
      }),
    );
    files.push(...batch.filter((file): file is SourceFile => file !== null));
  }
  return { sha, files };
}

function digest(files: SourceFile[], nodes: GraphNode[], edges: GraphEdge[]): string {
  const content = new Map(files.map((file) => [file.path, file.content]));
  const excerptChars = Math.min(EXCERPT_CHARS, Math.floor(DIGEST_BUDGET / Math.max(1, nodes.length)));
  return nodes
    .map((node) => {
      const links = edges
        .filter((edge) => edge.from === node.id)
        .map((edge) => `${edge.relation} ${edge.to}`)
        .join(", ");
      const header = `## ${node.id} (${node.kind}${node.path ? `, ${lineCount(content.get(node.path) ?? "")} lines` : ""})${links ? `\nLinks: ${links}` : ""}`;
      return node.path ? `${header}\n${(content.get(node.path) ?? "").slice(0, excerptChars)}` : header;
    })
    .join("\n\n");
}

async function labelWithModel(
  files: SourceFile[],
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<{ labels: Labels; usage: ModelUsage }> {
  const { text, usage } = await respond({
    instructions: CLUSTER_PROMPT,
    input: digest(files, nodes, edges),
    maxOutputTokens: MODEL_OUTPUT_TOKENS,
    format: { type: "json_schema", name: "code_network", strict: true, schema: CLUSTER_SCHEMA },
  });
  const parsed = JSON.parse(text) as {
    clusters: NetCluster[];
    nodes: { id: string; clusterId: string; label: string; summary: string }[];
  };
  return {
    labels: {
      clusters: parsed.clusters.map(({ id, name, summary }) => ({ id, name, summary })),
      nodes: new Map(parsed.nodes.map(({ id, ...rest }) => [id, rest])),
    },
    usage,
  };
}

// Reads a repository from GitHub, maps it into plain-language clusters, puts its code in the project's own Supermemory namespace and stores the network.
// Run: npx convex run codeNetwork/build:build '{"projectId":"<app id>","repo":"owner/name"}'
// With reuseLabels, the stored network's clusters, labels and summaries are kept and OpenAI is not called.
export const build = internalAction({
  args: {
    projectId: v.string(),
    repo: v.string(),
    ref: v.optional(v.string()),
    reuseLabels: v.optional(v.boolean()),
  },
  handler: async (ctx, { projectId, repo, ref, reuseLabels }): Promise<BuildResult> => {
    const missing = ["SUPERMEMORY_API_KEY", ...(reuseLabels ? [] : ["OPENAI_API_KEY"])].filter(
      (name) => !process.env[name],
    );
    if (missing.length) return { outcome: "not_configured", missing };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { outcome: "failed", reason: `repo must be owner/name, got ${repo}.` };

    const started = Date.now();
    const fetched = await fetchRepository(repo, ref ?? "HEAD", process.env.GITHUB_TOKEN);
    if ("reason" in fetched) return { outcome: "failed", reason: fetched.reason };
    const githubMs = Date.now() - started;
    const { nodes: graphNodes, edges } = buildGraph(fetched.files);
    if (graphNodes.length === 0) return { outcome: "failed", reason: `${repo} has no source files turtl can read.` };

    const modelStarted = Date.now();
    let labels: Labels;
    let usage: ModelUsage | null = null;
    if (reuseLabels) {
      const stored = await ctx.runQuery(internal.codeNetwork.network.stored, { projectId });
      if (!stored) return { outcome: "failed", reason: `reuseLabels needs a stored network for ${projectId}; none exists.` };
      labels = { clusters: stored.clusters, nodes: new Map(stored.nodes.map(({ id, ...rest }) => [id, rest])) };
    } else {
      ({ labels, usage } = await labelWithModel(fetched.files, graphNodes, edges));
    }
    const modelMs = Date.now() - modelStarted;

    const clusterIds = new Set(labels.clusters.map((cluster) => cluster.id));
    const assigned = new Map(
      [...labels.nodes.entries()].filter(([, label]) => clusterIds.has(label.clusterId)).map(([id, label]) => [id, label.clusterId]),
    );
    const clusterOf = fillClusters(graphNodes, edges, assigned, labels.clusters[0].id);
    const nodes: NetNode[] = graphNodes.map((node) => ({
      id: node.id,
      clusterId: clusterOf.get(node.id)!,
      label: labels.nodes.get(node.id)?.label ?? node.label,
      kind: node.kind,
      ...(node.path ? { path: node.path } : {}),
      summary: labels.nodes.get(node.id)?.summary ?? "",
      weight: node.weight,
    }));
    const clusters = labels.clusters.filter((cluster) => nodes.some((node) => node.clusterId === cluster.id));
    const clusterName = new Map(clusters.map((cluster) => [cluster.id, cluster.name]));

    const namespace = codeNamespace(projectId);
    const content = new Map(fetched.files.map((file) => [file.path, file.content]));
    const documentId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
    const documents: CodeDocument[] = [
      ...clusters.map((cluster) => ({
        id: documentId(`cluster_${cluster.id}`),
        content: `Part of the app: ${cluster.name}\n${cluster.summary}\n\nPieces:\n${nodes
          .filter((node) => node.clusterId === cluster.id)
          .map((node) => `- ${node.label}${node.path ? ` (${node.path})` : ""}: ${node.summary}`)
          .join("\n")}`,
        metadata: { kind: "cluster", clusterId: cluster.id },
      })),
      ...nodes.flatMap((node) =>
        node.path
          ? [
              {
                id: documentId(`file_${node.path}`),
                content: `File: ${node.path}\nPart of: ${clusterName.get(node.clusterId)}\nWhat it does: ${node.summary}\n\n${(content.get(node.path) ?? "").slice(0, DOCUMENT_CHARS)}`,
                metadata: { kind: "code", path: node.path, nodeId: node.id, clusterId: node.clusterId },
              },
            ]
          : [],
      ),
    ];
    const supermemoryStarted = Date.now();
    const added = await addDocuments(namespace, documents);
    const supermemoryMs = Date.now() - supermemoryStarted;

    await ctx.runMutation(internal.codeNetwork.network.store, {
      projectId,
      repo,
      ref: fetched.sha,
      namespace,
      source: "built",
      generatedAt: Date.now(),
      clusters,
      nodes,
      edges,
    });
    return {
      outcome: "built",
      projectId,
      repo,
      ref: fetched.sha,
      namespace,
      files: fetched.files.length,
      clusters: clusters.length,
      nodes: nodes.length,
      edges: edges.length,
      documents: added,
      model: usage,
      timings: { githubMs, modelMs, supermemoryMs, totalMs: Date.now() - started },
    };
  },
});
