import { v } from "convex/values";
import { internalAction } from "./_generated/server";

declare const process: { env: Record<string, string | undefined> };

export type NoticeResult = {
  outcome: "ran" | "queued" | "unavailable" | "not_configured" | "failed";
  status?: number;
};

const DEFAULT_BASE_URL = "https://onkeiki.com";
const MAX_TEXT_LENGTH = 600;
const REQUEST_TIMEOUT_MS = 10_000;
const OUTCOMES = ["ran", "queued", "unavailable"] as const;

// Tells the "turtl alerts" Keiki agent about an event so it can message the owner. Best effort:
// it never throws, and it reports "ran" only when Keiki says the notice ran. The text is written
// for the agent, which words the message itself; it is not delivered as is.
export async function sendOwnerNotice(text: string): Promise<NoticeResult> {
  const apiKey = process.env.KEIKI_API_KEY;
  const agentId = process.env.KEIKI_AGENT_ID;
  const phone = process.env.KEIKI_OWNER_CONTACT;
  if (!apiKey || !agentId || !phone) {
    return { outcome: "not_configured" };
  }
  const baseUrl = (process.env.KEIKI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  try {
    const response = await fetch(
      `${baseUrl}/api/v1/developer/agents/${encodeURIComponent(agentId)}/notice`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, MAX_TEXT_LENGTH), phone }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error(`Keiki owner notice failed with status ${response.status}`);
      return { outcome: "failed", status: response.status };
    }
    const body = (await response.json()) as { results?: { outcome?: string }[] };
    const outcome = OUTCOMES.find((candidate) => candidate === body.results?.[0]?.outcome);
    if (!outcome) {
      console.error(`Keiki owner notice returned no outcome, status ${response.status}`);
      return { outcome: "failed", status: response.status };
    }
    return { outcome, status: response.status };
  } catch (error) {
    console.error(
      `Keiki owner notice request failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return { outcome: "failed" };
  }
}

// Internal so only backend code can make the app message its owner.
export const notifyOwner = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }): Promise<NoticeResult> => sendOwnerNotice(text),
});
