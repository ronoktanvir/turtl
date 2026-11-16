import type { Gate } from "../consent/gate";
import { Refused, VendorError, vendorFailure } from "../consent/outbound";
import { modelCost } from "../spend/limits";

declare const process: { env: Record<string, string | undefined> };

export const DEFAULT_MODEL = "gpt-6-luna";

export type ModelUsage = { inputTokens: number; outputTokens: number };

// One OpenAI Responses call. Throws when OPENAI_API_KEY is missing, the gate says no (Refused), or the call fails
// (VendorError). Errors are plain words with OpenAI's status only: its own text can echo what was sent.
// store: false keeps OpenAI from holding the request and answer as application state for 30 days.
export async function respond(
  gate: Gate,
  {
    instructions,
    input,
    maxOutputTokens,
    format,
  }: {
    instructions: string;
    input: string | { role: "user" | "assistant"; content: string }[];
    maxOutputTokens: number;
    format?: { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> };
  },
): Promise<{ text: string; usage: ModelUsage }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Set it with: npx convex env set OPENAI_API_KEY <value>");
  const opened = await gate.open("openai");
  if (!opened.ok) throw new Refused(opened.reason);
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  let response: Response;
  try {
    response = await opened.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        store: false,
        ...(format ? { text: { format } } : {}),
      }),
    });
  } catch (error) {
    console.error(`OpenAI request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    throw new VendorError("OpenAI could not be reached");
  }
  if (!response.ok) throw await vendorFailure("OpenAI", response);
  const body = (await response.json()) as {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const usage = { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
  await gate.spent(modelCost(model, body.usage ? usage : null));
  const text = (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new VendorError("OpenAI returned no text reply");
  return { text, usage };
}
