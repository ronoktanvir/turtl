import { Supermemory } from "supermemory";

declare const process: { env: Record<string, string | undefined> };

export type MemoryMetadata = Record<string, string | number | boolean | string[]>;

// A Supermemory namespace is 1 to 100 characters of letters, digits, "_", ":" or "-".
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_:-]{1,100}$/;

function client(namespace: string): Supermemory {
  const apiKey = process.env.SUPERMEMORY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SUPERMEMORY_API_KEY is not set. Set it with: npx convex env set SUPERMEMORY_API_KEY <value>",
    );
  }
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      "The Supermemory namespace must be 1 to 100 characters of letters, digits, underscore, colon, or hyphen.",
    );
  }
  return new Supermemory({ apiKey });
}

// Memory texts in `namespace` that are relevant to `query`, best first.
export async function searchMemories(
  namespace: string,
  query: string,
  limit = 8,
): Promise<string[]> {
  const { results } = await client(namespace).search(namespace, { query, limit });
  return results.flatMap((result) => {
    const text = result.memory ?? result.chunk;
    return text ? [text] : [];
  });
}

// Adds `content` to `namespace`; memories are formed in the background.
export async function addMemory(
  namespace: string,
  content: string,
  metadata: MemoryMetadata,
): Promise<void> {
  await client(namespace).add(namespace, { content, metadata, dreaming: "instant" });
}

export type CodeDocument = { id: string; content: string; metadata: MemoryMetadata };
export type DocumentMatch = { field: string; value: string };

const BATCH_SIZE = 20;
const BATCH_TIMEOUT_SECONDS = 180;

// Adds documents to `namespace` for retrieval only, without memory extraction. Whole source files are large, so it sends 20 per request.
export async function addDocuments(
  namespace: string,
  documents: CodeDocument[],
): Promise<{ count: number; failed: number }> {
  const supermemory = client(namespace);
  let count = 0;
  let failed = 0;
  for (let start = 0; start < documents.length; start += BATCH_SIZE) {
    const response = await supermemory.documents.batchAdd(
      namespace,
      { documents: documents.slice(start, start + BATCH_SIZE), taskType: "superrag" },
      { timeoutInSeconds: BATCH_TIMEOUT_SECONDS },
    );
    count += response.count;
    failed += response.failed;
  }
  return { count, failed };
}

// Source chunks in `namespace` relevant to `query`, best first. With `anyOf`, only chunks of documents whose metadata matches one of them.
export async function searchChunks(
  namespace: string,
  query: string,
  { limit = 8, anyOf = [] }: { limit?: number; anyOf?: DocumentMatch[] } = {},
): Promise<{ text: string; metadata: Record<string, unknown> }[]> {
  const predicates = anyOf.map(({ field, value }) => ({ field, operator: "eq" as const, value }));
  const filter =
    predicates.length === 0 ? undefined : predicates.length === 1 ? predicates[0] : { operator: "or" as const, operands: predicates };
  const { results } = await client(namespace).search(namespace, {
    query,
    searchMode: "chunks",
    limit,
    ...(filter ? { filter } : {}),
  });
  return results.flatMap((result) => {
    const text = result.chunk ?? result.memory;
    return text ? [{ text, metadata: result.metadata }] : [];
  });
}
