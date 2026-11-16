import { NO_MODEL_REASON } from "../constants";
import type { Gate } from "../consent/gate";
import { VOICE_CALL_ESTIMATE_USD } from "../spend/limits";
import { clipExtension } from "./rules";

declare const process: { env: Record<string, string | undefined> };

// OpenAI speech to text and text to speech for voice turns. Each returns what happened, never throws. Each asks the
// case's gate first (convex/consent/gate.ts), so in accounts mode no recording leaves without the owner's permission.

const TIMEOUT_MS = 30_000;
export const transcribeModelId = () => process.env.VOICE_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
export const speechModelId = () => process.env.VOICE_SPEECH_MODEL || "gpt-4o-mini-tts";
const VOICE = "sage";
const SPEECH_STYLE = "Calm, clear and unhurried, like a colleague on call talking someone through an incident. Plain words.";

async function call(gate: Gate, path: string, init: RequestInit): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: NO_MODEL_REASON };
  const opened = await gate.open("openai");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await opened.fetch(`https://api.openai.com/v1/${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `the model call returned HTTP ${response.status}` };
    // Audio calls report no token counts, so each one is counted at a flat estimate.
    await gate.spent(VOICE_CALL_ESTIMATE_USD);
    return { ok: true, response };
  } catch (error) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `the model did not answer within ${TIMEOUT_MS / 1000} s`
        : `the model call failed (${error instanceof Error ? error.name : "unknown error"})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribe(
  gate: Gate,
  audio: ArrayBuffer,
  mimeType: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `clip.${clipExtension(mimeType) ?? "webm"}`);
  form.append("model", transcribeModelId());
  form.append("response_format", "json");
  form.append("prompt", prompt);
  const result = await call(gate, "audio/transcriptions", { method: "POST", body: form });
  if (!result.ok) return result;
  try {
    const body = (await result.response.json()) as { text?: unknown };
    return { ok: true, text: typeof body.text === "string" ? body.text.trim() : "" };
  } catch {
    return { ok: false, reason: "the transcription was not readable JSON" };
  }
}

export async function speak(gate: Gate, text: string): Promise<{ ok: true; audio: ArrayBuffer } | { ok: false; reason: string }> {
  const result = await call(gate, "audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: speechModelId(), voice: VOICE, input: text, instructions: SPEECH_STYLE, response_format: "mp3" }),
  });
  if (!result.ok) return result;
  const audio = await result.response.arrayBuffer();
  return audio.byteLength ? { ok: true, audio } : { ok: false, reason: "the speech model returned no audio" };
}
