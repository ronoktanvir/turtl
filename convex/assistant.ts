import { v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";
import { addMemory, searchMemories } from "./supermemory";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_MODEL = "gpt-6-luna";
const MAX_MESSAGE_LENGTH = 2000;
const MAX_OUTPUT_TOKENS = 1500;

const SYSTEM_PROMPT = [
  "You are turtl's on-call assistant. turtl helps people who own a live app and have no operations team handle outages, bug reports, and feature requests.",
  "Be brief, concrete, and calm. Give the next step to take, not a lecture.",
  "Use the remembered context about this user and the case details when they help, and never invent facts that are in neither.",
  "If you are not sure, say so.",
].join(" ");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Set it with: npx convex env set ${name} <value>`,
    );
  }
  return value;
}

export const chat = action({
  args: {
    userId: v.string(),
    message: v.string(),
    caseId: v.optional(v.id("cases")),
  },
  handler: async (
    ctx,
    { userId, message, caseId },
  ): Promise<{ reply: string; memories: string[] }> => {
    if (process.env.ASSISTANT_ENABLED !== "true") {
      throw new Error(
        "The assistant is disabled on this deployment. Set ASSISTANT_ENABLED to true with: npx convex env set ASSISTANT_ENABLED true",
      );
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`message is too long: ${message.length} characters, the limit is ${MAX_MESSAGE_LENGTH}.`);
    }
    const openaiKey = requireEnv("OPENAI_API_KEY");

    const memories = await searchMemories(userId, message);

    const caseRow = caseId ? await ctx.runQuery(api.cases.get, { id: caseId }) : null;
    const context = [
      memories.length
        ? `What you remember about this user:\n${memories.map((text) => `- ${text}`).join("\n")}`
        : "You have no remembered context about this user yet.",
      caseRow
        ? `The case they are asking about: "${caseRow.title}" (${caseRow.kind}, raised by ${caseRow.raisedBy}, status ${caseRow.status}). Impact: ${caseRow.impact}\nCurrent steps:\n${caseRow.steps
            .map((step) => {
              const attempt = step.currentAttempt;
              const detail = attempt?.summary ?? attempt?.error;
              return `- ${step.title} (${step.purpose}): ${step.status}${detail ? `. ${detail}` : ""}`;
            })
            .join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        instructions: `${SYSTEM_PROMPT}\n\n${context}`,
        input: message,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as {
      output?: { type: string; content?: { type: string; text?: string }[] }[];
    };
    const reply = (body.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!reply) throw new Error("OpenAI returned no text reply.");

    const metadata = (role: "user" | "assistant") => ({
      role,
      ...(caseId ? { caseId } : {}),
    });
    await Promise.all([
      addMemory(userId, `User: ${message}`, metadata("user")),
      addMemory(userId, `Assistant: ${reply}`, metadata("assistant")),
    ]);

    return { reply, memories };
  },
});
