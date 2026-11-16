import type { ExpoMessage } from "./message";

declare const process: { env: Record<string, string | undefined> };

// Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/). Best effort: these never
// throw, and a failed request is reported as a status, not retried here.

// EXPO_PUSH_API_URL points the module at a stand-in for Expo in tests. Leave it unset on a real deployment.
export const expoPushApiUrl = () => (process.env.EXPO_PUSH_API_URL || "https://exp.host/--/api/v2/push").replace(/\/+$/, "");

const REQUEST_TIMEOUT_MS = 10_000;
/** Expo takes at most 100 messages and 1000 receipt ids per request. */
export const MAX_MESSAGES = 100;
export const MAX_RECEIPT_IDS = 1000;
/** Expo's error code for a token the phone no longer accepts. Stop sending to it until the phone registers again. */
export const NOT_REGISTERED = "DeviceNotRegistered";

export type Ticket = { ok: true; receiptId?: string } | { ok: false; error: string };
export type SendResult = { ok: true; status: number; tickets: Ticket[] } | { ok: false; status?: number };
export type ReceiptsResult = { ok: true; status: number; receipts: Record<string, Ticket> } | { ok: false; status?: number };

function headers(): Record<string, string> {
  const token = process.env.EXPO_ACCESS_TOKEN;
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function ticketOf(raw: unknown): Ticket {
  const row = (raw && typeof raw === "object" ? raw : {}) as { status?: unknown; id?: unknown; details?: { error?: unknown } };
  if (row.status === "ok") return { ok: true, ...(typeof row.id === "string" ? { receiptId: row.id } : {}) };
  const code = row.details && typeof row.details.error === "string" ? row.details.error : "Unknown";
  return { ok: false, error: code.slice(0, 64) };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown } | { status?: number; failed: true }> {
  try {
    const response = await fetch(`${expoPushApiUrl()}/${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`Expo push ${path} failed with status ${response.status}`);
      return { status: response.status, failed: true };
    }
    return { status: response.status, json: await response.json() };
  } catch (error) {
    console.error(`Expo push ${path} request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return { failed: true };
  }
}

/** Sends the messages and returns one ticket per message, in order. */
export async function sendToExpo(messages: ExpoMessage[]): Promise<SendResult> {
  if (messages.length === 0) return { ok: true, status: 200, tickets: [] };
  if (messages.length > MAX_MESSAGES) throw new Error(`At most ${MAX_MESSAGES} push messages per request.`);
  const result = await post("send", messages);
  if ("failed" in result) return { ok: false, status: result.status };
  const data = (result.json as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== messages.length) {
    console.error(`Expo push send returned ${Array.isArray(data) ? data.length : "no"} tickets for ${messages.length} messages`);
    return { ok: false, status: result.status };
  }
  return { ok: true, status: result.status, tickets: data.map(ticketOf) };
}

/** Reads the receipts for these ticket ids. An id with no receipt yet is missing from the answer. */
export async function receiptsFromExpo(ids: string[]): Promise<ReceiptsResult> {
  if (ids.length === 0) return { ok: true, status: 200, receipts: {} };
  if (ids.length > MAX_RECEIPT_IDS) throw new Error(`At most ${MAX_RECEIPT_IDS} receipt ids per request.`);
  const result = await post("getReceipts", { ids });
  if ("failed" in result) return { ok: false, status: result.status };
  const data = (result.json as { data?: unknown })?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, status: result.status };
  const receipts: Record<string, Ticket> = {};
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(data, id)) receipts[id] = ticketOf((data as Record<string, unknown>)[id]);
  }
  return { ok: true, status: result.status, receipts };
}
