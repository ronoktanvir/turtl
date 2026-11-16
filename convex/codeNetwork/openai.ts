declare const process: { env: Record<string, string | undefined> };

const DEFAULT_MODEL = "gpt-6-luna";

export type ModelUsage = { inputTokens: number; outputTokens: number };

// One OpenAI Responses call, the way convex/assistant.ts makes it. Throws when OPENAI_API_KEY is missing or the call fails.
export async function respond({
  instructions,
  input,
  maxOutputTokens,
  format,
}: {
  instructions: string;
  input: string | { role: "user" | "assistant"; content: string }[];
  maxOutputTokens: number;
  format?: { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> };
}): Promise<{ text: string; usage: ModelUsage }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Set it with: npx convex env set OPENAI_API_KEY <value>");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      ...(format ? { text: { format } } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("OpenAI returned no text reply.");
  return {
    text,
    usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
  };
}
