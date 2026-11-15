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
