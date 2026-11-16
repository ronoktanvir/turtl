import type { Gate } from "../consent/gate";
import { callEstimate, modelCost } from "../spend/limits";
import { estimateCostUsd, PROVIDER_KEYS, type ModelRef, type Provider } from "./configs";

declare const process: { env: Record<string, string | undefined> };

// One JSON-answering model call for any provider in PROVIDER_KEYS. A configuration names a provider and a model; the
// key comes from the deployment's environment. Call only from Convex actions, with the project's gate
// (convex/consent/gate.ts): in accounts mode nothing is sent without the owner's permission or past their limit.

export type ModelCall = {
  ref: ModelRef;
  system: string;
  user: string;
  timeoutMs: number;
  maxOutputTokens: number;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type ModelAnswer =
  | { ok: true; json: Record<string, unknown>; usage?: Usage; costUsd?: number; durationMs: number }
  | { ok: false; reason: string; infra: boolean; blocked?: true; usage?: Usage; costUsd?: number; durationMs: number };

export function providerKey(provider: Provider): string | undefined {
  return process.env[PROVIDER_KEYS[provider]] || undefined;
}

export const describeModel = (ref: ModelRef) => `${ref.model}${ref.reasoning ? ` (${ref.reasoning} reasoning)` : ""}`;

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Request = { url: string; headers: Record<string, string>; body: unknown; read: (body: any) => { text?: string; usage?: Usage } };

function request(call: ModelCall, key: string): Request {
  const { ref, system, user, maxOutputTokens } = call;
  if (ref.provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: { model: ref.model, max_tokens: maxOutputTokens, system, messages: [{ role: "user", content: user }] },
      read: (body) => ({
        text: (body?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join(""),
        usage: body?.usage && { inputTokens: body.usage.input_tokens ?? 0, outputTokens: body.usage.output_tokens ?? 0 },
      }),
    };
  }
  if (ref.provider === "google") {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ref.model)}:generateContent`,
      headers: { "x-goog-api-key": key },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens },
      },
      read: (body) => ({
        text: (body?.candidates?.[0]?.content?.parts ?? []).map((part: any) => part?.text ?? "").join(""),
        usage: body?.usageMetadata && {
          inputTokens: body.usageMetadata.promptTokenCount ?? 0,
          outputTokens: (body.usageMetadata.candidatesTokenCount ?? 0) + (body.usageMetadata.thoughtsTokenCount ?? 0),
        },
      }),
    };
  }
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model: ref.model,
      ...(ref.reasoning && { reasoning_effort: ref.reasoning }),
      max_completion_tokens: maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    read: (body) => ({
      text: body?.choices?.[0]?.message?.content ?? undefined,
      usage: body?.usage && { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 },
    }),
  };
}

// Infrastructure failures (no key, no answer in time, a refused or failed request) are kept apart from answers that
// arrived but could not be used, because only the second says anything about the configuration's reasoning.
// A refusal from the gate is an infrastructure failure marked blocked, so nothing hands it up to a stronger model.
// The owner reads a reason like this on the case, so it names the provider, never the setting that holds its key.
const PROVIDER_NAMES: Record<Provider, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini" };

export async function callModel(gate: Gate, call: ModelCall): Promise<ModelAnswer> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const key = providerKey(call.ref.provider);
  if (!key) return { ok: false, infra: true, reason: `${PROVIDER_NAMES[call.ref.provider]} is not connected to turtl yet, so no request was sent`, durationMs: 0 };
  const opened = await gate.open(call.ref.provider, "send", callEstimate(call.ref.model, [call.system, call.user], call.maxOutputTokens));
  if (!opened.ok) return { ok: false, infra: true, blocked: true, reason: opened.reason, durationMs: 0 };
  const { url, headers, body, read } = request(call, key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  try {
    const response = await opened.fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, infra: true, reason: `${call.ref.model} returned HTTP ${response.status}`, durationMs: elapsed() };
    const { text, usage } = read(await response.json());
    const costUsd = usage && estimateCostUsd(call.ref.model, usage.inputTokens, usage.outputTokens);
    await gate.spent(modelCost(call.ref.model, usage));
    const json = parseJson(text);
    const metered = { ...(usage && { usage }), ...(costUsd !== undefined && { costUsd }) };
    if (!json) return { ok: false, infra: false, reason: `${call.ref.model} answered without a usable JSON object`, durationMs: elapsed(), ...metered };
    return { ok: true, json, durationMs: elapsed(), ...metered };
  } catch (error) {
    return {
      ok: false,
      infra: true,
      reason: controller.signal.aborted
        ? `${call.ref.model} did not answer within ${call.timeoutMs / 1000} s`
        : `the call to ${call.ref.model} failed (${error instanceof Error ? error.name : "unknown error"})`,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}
