// Builds the import, call and data graph of a repository from its source files. Pure: no imports, so the seed script can run it under Node.

export type NodeKind = "screen" | "module" | "service" | "data" | "external";
export type Relation = "imports" | "calls" | "reads" | "writes" | "depends_on";
export type SourceFile = { path: string; content: string };
export type GraphNode = { id: string; kind: NodeKind; label: string; path?: string; weight: number };
export type GraphEdge = { from: string; to: string; relation: Relation };

const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIPPED = /(^|\/)(node_modules|_generated|\.[^/]+)\/|\.(test|spec|d)\.[a-z]+$|^scripts\/|(babel|metro|jest)\.config\.js$/;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

const EXTERNALS: { id: string; label: string; pattern: RegExp }[] = [
  { id: "external:supermemory", label: "Supermemory", pattern: /from\s+["']supermemory["']/ },
  { id: "external:openai", label: "OpenAI", pattern: /api\.openai\.com/ },
  { id: "external:keiki", label: "Keiki", pattern: /onkeiki\.com/ },
  { id: "external:github", label: "GitHub", pattern: /api\.github\.com/ },
];

export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSION.test(path) && !SKIPPED.test(path);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveImport(from: string, specifier: string, paths: Set<string>): string | undefined {
  const base = specifier.startsWith("@/")
    ? specifier.slice(2)
    : normalize(`${from.split("/").slice(0, -1).join("/")}/${specifier}`);
  const stripped = base.replace(/\.js$/, "");
  return RESOLVE_SUFFIXES.map((suffix) => stripped + suffix).find((candidate) => paths.has(candidate));
}

export function defaultKind(path: string): NodeKind {
  if (path.startsWith("app/") || path.endsWith(".tsx")) return "screen";
  if (/(^|\/)(http|crons)\.ts$|\/handlers\//.test(path)) return "service";
  return "module";
}

export function defaultLabel(id: string): string {
  const name = id.replace(/^(table|external):/, "").split("/").pop()!.replace(SOURCE_EXTENSION, "");
  const words = name.replace(/\[(\w+)\]/, "$1").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function lineCount(content: string): number {
  return content.split("\n").length;
}

export function buildGraph(files: SourceFile[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const sources = files.filter((file) => isSourcePath(file.path));
  const paths = new Set(sources.map((file) => file.path));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string, relation: Relation) => {
    if (from !== to) edges.set(`${from}|${to}|${relation}`, { from, to, relation });
  };

  for (const file of sources) {
    nodes.set(file.path, {
      id: file.path,
      kind: defaultKind(file.path),
      label: defaultLabel(file.path),
      path: file.path,
      weight: Math.min(5, Math.max(1, Math.round(Math.sqrt(lineCount(file.content) / 40)))),
    });
  }

  for (const file of sources) {
    const text = file.content;
    for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const target = resolveImport(file.path, specifier, paths);
      if (target) addEdge(file.path, target, "imports");
    }
    for (const match of text.matchAll(/\b(?:api|internal)\.((?:[A-Za-z_]\w*\.)+)[A-Za-z_]\w*/g)) {
      const segments = match[1].slice(0, -1).split(".");
      const target = RESOLVE_SUFFIXES.slice(1, 3)
        .map((suffix) => `convex/${segments.join("/")}${suffix}`)
        .find((candidate) => paths.has(candidate));
      if (target) addEdge(file.path, target, "calls");
    }
    for (const match of text.matchAll(/\.db\s*\.\s*(query|insert)\(\s*["']([A-Za-z]\w*)["']/g)) {
      const id = `table:${match[2]}`;
      if (!nodes.has(id)) nodes.set(id, { id, kind: "data", label: defaultLabel(id), weight: 1 });
      addEdge(file.path, id, match[1] === "insert" ? "writes" : "reads");
    }
    for (const external of EXTERNALS) {
      if (!external.pattern.test(text)) continue;
      if (!nodes.has(external.id)) nodes.set(external.id, { id: external.id, kind: "external", label: external.label, weight: 1 });
      addEdge(file.path, external.id, "calls");
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// Places nodes the labels did not cover in the cluster most of their neighbours belong to.
export function fillClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
  assigned: Map<string, string>,
  fallback: string,
): Map<string, string> {
  const result = new Map(assigned);
  for (const node of nodes) {
    if (result.has(node.id)) continue;
    const votes = new Map<string, number>();
    for (const edge of edges) {
      const other = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : undefined;
      const cluster = other && assigned.get(other);
      if (cluster) votes.set(cluster, (votes.get(cluster) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    result.set(node.id, best?.[0] ?? fallback);
  }
  return result;
}
