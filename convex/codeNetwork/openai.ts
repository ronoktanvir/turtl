import { NO_MODEL_REASON } from "../constants";
import type { Gate } from "../consent/gate";
import { Refused, VendorError, vendorFailure } from "../consent/outbound";
import { callEstimate, modelCost } from "../spend/limits";

declare const process: { env: Record<string, string | undefined> };

export const DEFAULT_MODEL = "gpt-6-luna";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
  if (!apiKey) throw new Error(`${capitalize(NO_MODEL_REASON)}.`);
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const promptChars = instructions.length + (typeof input === "string" ? input.length : input.reduce((sum, item) => sum + item.content.length, 0));
  const opened = await gate.open("openai", "send", callEstimate(model, promptChars, maxOutputTokens));
  if (!opened.ok) throw new Refused(opened.reason);
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
