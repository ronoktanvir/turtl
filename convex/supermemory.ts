import { Supermemory } from "supermemory";
import { unscopedGate, type Gate } from "./consent/gate";
import { Refused, VendorError } from "./consent/outbound";

declare const process: { env: Record<string, string | undefined> };

// Every call takes the project's gate (convex/consent/gate.ts): in accounts mode nothing reaches Supermemory for an
// owner who has not allowed it, and the client's only fetch is the one the gate hands back. A failed call throws a
// plain error with Supermemory's status, never its text.

export type MemoryMetadata = Record<string, string | number | boolean | string[]>;

// A Supermemory namespace is 1 to 100 characters of letters, digits, "_", ":" or "-".
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_:-]{1,100}$/;

// A local proof sets SUPERMEMORY_NAMESPACE_PREFIX so its writes never mix with a hosted project's memory.
const scoped = (namespace: string) => `${process.env.SUPERMEMORY_NAMESPACE_PREFIX ?? ""}${namespace}`;

async function client(gate: Gate, namespace: string, purpose: "send" | "erase" = "send"): Promise<Supermemory> {
  const apiKey = process.env.SUPERMEMORY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SUPERMEMORY_API_KEY is not set. Set it with: npx convex env set SUPERMEMORY_API_KEY <value>",
    );
  }
  if (!NAMESPACE_PATTERN.test(scoped(namespace))) {
    throw new Error(
      "The Supermemory namespace must be 1 to 100 characters of letters, digits, underscore, colon, or hyphen.",
    );
  }
  const opened = await gate.open("supermemory", purpose);
  if (!opened.ok) throw new Refused(opened.reason);
  return new Supermemory({ apiKey, fetch: opened.fetch });
}

// Supermemory's errors carry its response body, which can echo what was sent. Logs keep the status alone.
async function plainly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused || error instanceof VendorError) throw error;
    const status = (error as { statusCode?: unknown })?.statusCode;
    console.error(`Supermemory request failed: ${typeof status === "number" ? `status ${status}` : error instanceof Error ? error.name : "unknown error"}`);
    throw new VendorError(
      typeof status === "number" ? `Supermemory answered with an error (status ${status})` : "Supermemory could not be reached",
      typeof status === "number" ? status : undefined,
    );
  }
}

// Memory texts in `namespace` that are relevant to `query`, best first.
export async function searchMemories(gate: Gate, namespace: string, query: string, limit?: number): Promise<string[]>;
/** For convex/assistant.ts until it is deleted (TUR-61). No project owns these calls, so accounts mode refuses them. */
export async function searchMemories(namespace: string, query: string, limit?: number): Promise<string[]>;
export async function searchMemories(a: Gate | string, b: string, c?: string | number, d?: number): Promise<string[]> {
  const [gate, namespace, query, limit] = typeof a === "string" ? [unscopedGate(), a, b, (c as number | undefined) ?? 8] : [a, b, c as string, d ?? 8];
  const supermemory = await client(gate, namespace);
  return await plainly(async () => {
    const { results } = await supermemory.search(scoped(namespace), { query, limit });
    return results.flatMap((result) => {
      const text = result.memory ?? result.chunk;
      return text ? [text] : [];
    });
  });
}

// Adds `content` to `namespace`; memories are formed in the background.
export async function addMemory(gate: Gate, namespace: string, content: string, metadata: MemoryMetadata): Promise<void>;
/** For convex/assistant.ts until it is deleted (TUR-61). No project owns these calls, so accounts mode refuses them. */
export async function addMemory(namespace: string, content: string, metadata: MemoryMetadata): Promise<void>;
export async function addMemory(a: Gate | string, b: string, c: string | MemoryMetadata, d?: MemoryMetadata): Promise<void> {
  const [gate, namespace, content, metadata] = typeof a === "string" ? [unscopedGate(), a, b, c as MemoryMetadata] : [a, b, c as string, d ?? {}];
  const supermemory = await client(gate, namespace);
  await plainly(async () => {
    await supermemory.add(scoped(namespace), { content, metadata, dreaming: "instant" });
  });
}

// Adds or replaces the document with this id in `namespace` and returns Supermemory's document id.
export async function putDocument(
  gate: Gate,
  namespace: string,
  id: string,
  content: string,
  metadata: MemoryMetadata,
): Promise<string> {
  const supermemory = await client(gate, namespace);
  return await plainly(async () => {
    const response = await supermemory.add(scoped(namespace), { id, content, metadata, dreaming: "instant" });
    return response.id;
  });
}

// Deleting sends only the ids, so it goes through even after the owner took permission back.
export async function deleteDocuments(gate: Gate, namespace: string, ids: string[]): Promise<void> {
  const supermemory = await client(gate, namespace, "erase");
  await plainly(async () => {
    await supermemory.documents.delete(scoped(namespace), { ids });
  });
}

// Search results with their metadata, best first.
export async function searchWithMetadata(
  gate: Gate,
  namespace: string,
  query: string,
  limit = 8,
): Promise<{ text: string; metadata: Record<string, unknown> }[]> {
  const supermemory = await client(gate, namespace);
  return await plainly(async () => {
    const { results } = await supermemory.search(scoped(namespace), { query, limit });
    return results.flatMap((result) => {
      const text = result.memory ?? result.chunk;
      return text ? [{ text, metadata: result.metadata ?? {} }] : [];
    });
  });
}

export type CodeDocument = { id: string; content: string; metadata: MemoryMetadata };
export type DocumentMatch = { field: string; value: string };

const BATCH_SIZE = 20;
const BATCH_TIMEOUT_SECONDS = 180;

// Adds documents to `namespace` for retrieval only, without memory extraction. Whole source files are large, so it
// sends 20 per request, and asks the gate before each one: taking permission back stops a long upload part way.
export async function addDocuments(
  gate: Gate,
  namespace: string,
  documents: CodeDocument[],
): Promise<{ count: number; failed: number }> {
  let count = 0;
  let failed = 0;
  for (let start = 0; start < documents.length; start += BATCH_SIZE) {
    const supermemory = await client(gate, namespace);
    const response = await plainly(() =>
      supermemory.documents.batchAdd(
        scoped(namespace),
        { documents: documents.slice(start, start + BATCH_SIZE), taskType: "superrag" },
        { timeoutInSeconds: BATCH_TIMEOUT_SECONDS },
      ),
    );
    count += response.count;
    failed += response.failed;
  }
  return { count, failed };
}

// Source chunks in `namespace` relevant to `query`, best first. With `anyOf`, only chunks of documents whose metadata matches one of them.
export async function searchChunks(
  gate: Gate,
  namespace: string,
  query: string,
  { limit = 8, anyOf = [] }: { limit?: number; anyOf?: DocumentMatch[] } = {},
): Promise<{ text: string; metadata: Record<string, unknown> }[]> {
  const predicates = anyOf.map(({ field, value }) => ({ field, operator: "eq" as const, value }));
  const filter =
    predicates.length === 0 ? undefined : predicates.length === 1 ? predicates[0] : { operator: "or" as const, operands: predicates };
  const supermemory = await client(gate, namespace);
  return await plainly(async () => {
    const { results } = await supermemory.search(scoped(namespace), {
      query,
      searchMode: "chunks",
      limit,
      ...(filter ? { filter } : {}),
    });
    return results.flatMap((result) => {
      const text = result.chunk ?? result.memory;
      return text ? [{ text, metadata: result.metadata }] : [];
    });
  });
}
