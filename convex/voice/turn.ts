import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation, query, type ActionCtx } from "../_generated/server";
import { speak, speechModelId, transcribe, transcribeModelId } from "./openai";
import {
  clipExtension,
  COMMAND_REPLIES,
  endsConversation,
  MAX_CLIP_BYTES,
  MAX_CLIP_MS,
  MAX_TURNS_PER_WINDOW,
  ownerCommand,
  RATE_WINDOW_MS,
  spokenText,
  unavailableReason,
  type OwnerCommand,
} from "./rules";

declare const process: { env: Record<string, string | undefined> };

// A spoken turn in a case's Investigate further chat: the owner's clip is transcribed, answered by the same
// case chat that typed questions use (fixes.investigate), and the reply is spoken back. Speech never makes an
// owner decision: a spoken approve, decline, merge or stop is answered with where its button is.

const MAX_TRANSCRIPT_CHARS = 2000;
const GOODBYE_REPLY = "Okay, I've stopped listening. Tap Talk when you want me again.";

export type TalkResult =
  | { ok: false; reason: string; retry: boolean }
  | {
      ok: true;
      transcript: string;
      reply: string;
      command: OwnerCommand | null;
      ended: boolean;
      audio: ArrayBuffer | null;
      speechError: string | null;
    };

export const status = query({
  args: { caseId: v.string() },
  handler: async (ctx, args): Promise<{ available: boolean; reason: string | null; maxClipMs: number }> => {
    const caseId = ctx.db.normalizeId("cases", args.caseId);
    if (!caseId || !(await ctx.db.get(caseId))) return { available: false, reason: "This case was not found.", maxClipMs: MAX_CLIP_MS };
    const reason = unavailableReason(process.env);
    return { available: !reason, reason, maxClipMs: MAX_CLIP_MS };
  },
});

export const begin = internalMutation({
  args: { caseId: v.id("cases") },
  handler: async (
    ctx,
    { caseId },
  ): Promise<{ ok: true; turnId: Id<"voiceTurns">; title: string; appName: string } | { ok: false; reason: string }> => {
    const row = await ctx.db.get(caseId);
    if (!row) return { ok: false, reason: "This case was not found." };
    const now = Date.now();
    const recent = await ctx.db
      .query("voiceTurns")
      .withIndex("by_case_and_start", (q) => q.eq("caseId", caseId).gte("startedAt", now - RATE_WINDOW_MS))
      .take(MAX_TURNS_PER_WINDOW);
    if (recent.length >= MAX_TURNS_PER_WINDOW) {
      return {
        ok: false,
        reason: `You've talked with turtl ${MAX_TURNS_PER_WINDOW} times about this case in the last ${RATE_WINDOW_MS / 60_000} minutes, which is the limit. Wait a few minutes, or type your question.`,
      };
    }
    const turnId = await ctx.db.insert("voiceTurns", { caseId, startedAt: now });
    return { ok: true, turnId, title: row.title, appName: (await ctx.db.get(row.appId))?.name ?? "the app" };
  },
});

export const finish = internalMutation({
  args: {
    turnId: v.id("voiceTurns"),
    outcome: v.union(v.literal("answered"), v.literal("command"), v.literal("ended"), v.literal("no_speech"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { turnId, ...result }) => {
    await ctx.db.patch(turnId, { ...result, finishedAt: Date.now() });
  },
});

async function timed<T extends { ok: boolean }>(
  ctx: ActionCtx,
  caseId: Id<"cases">,
  run: { taskType: string; modelId: string; promptVersion: string },
  call: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const result = await call();
  await ctx.runMutation(internal.voice.runs.record, {
    caseId,
    ...run,
    routingReason: "Voice turn on the case chat: one fixed OpenAI audio model, no routing.",
    ok: result.ok,
    ...(!result.ok && "reason" in result ? { error: String(result.reason) } : {}),
    durationMs: Date.now() - started,
  });
  return result;
}

export const talk = action({
  args: { caseId: v.id("cases"), audio: v.bytes(), mimeType: v.string(), durationMs: v.number() },
  handler: async (ctx, { caseId, audio, mimeType, durationMs }): Promise<TalkResult> => {
    const unavailable = unavailableReason(process.env);
    if (unavailable) return { ok: false, reason: unavailable, retry: false };
    if (!clipExtension(mimeType)) return { ok: false, reason: `turtl can't read ${mimeType} recordings.`, retry: false };
    if (durationMs > MAX_CLIP_MS + 2_000 || audio.byteLength > MAX_CLIP_BYTES) {
      return { ok: false, reason: `That recording is longer than turtl takes (${MAX_CLIP_MS / 1000} seconds). Ask a shorter question.`, retry: true };
    }
    if (!audio.byteLength) return { ok: false, reason: "turtl didn't hear a question. Ask again, or end the conversation.", retry: true };

    const turn = await ctx.runMutation(internal.voice.turn.begin, { caseId });
    if (!turn.ok) return { ok: false, reason: turn.reason, retry: false };
    const end = (outcome: "answered" | "command" | "ended" | "no_speech" | "failed", error?: string) =>
      ctx.runMutation(internal.voice.turn.finish, { turnId: turn.turnId, outcome, ...(error ? { error } : {}) });
    try {
      const heard = await timed(ctx, caseId, { taskType: "voice_transcription", modelId: transcribeModelId(), promptVersion: "voice-transcribe-1" }, () =>
        transcribe(audio, mimeType, `The owner of ${turn.appName} is asking turtl, an on-call assistant, about the case "${turn.title}".`),
      );
      if (!heard.ok) {
        await end("failed", heard.reason);
        return { ok: false, reason: `turtl couldn't make out the recording: ${heard.reason}.`, retry: true };
      }
      const transcript = heard.text.slice(0, MAX_TRANSCRIPT_CHARS);
      if (!/[\p{L}\p{N}]/u.test(transcript)) {
        await end("no_speech");
        return { ok: false, reason: "turtl didn't hear a question. Ask again, or end the conversation.", retry: true };
      }

      const ended = endsConversation(transcript);
      const command = ended ? null : ownerCommand(transcript);
      let reply: string;
      if (ended || command) {
        reply = ended ? GOODBYE_REPLY : COMMAND_REPLIES[command!];
        await ctx.runMutation(internal.fixes.addMessage, { caseId, role: "owner", text: transcript });
        await ctx.runMutation(internal.fixes.addMessage, { caseId, role: "turtl", text: reply });
      } else {
        reply = (await ctx.runAction(api.fixes.investigate, { caseId, message: transcript })).text;
      }

      const voice = await timed(ctx, caseId, { taskType: "voice_speech", modelId: speechModelId(), promptVersion: "voice-speech-1" }, () =>
        speak(spokenText(reply)),
      );
      await end(ended ? "ended" : command ? "command" : "answered", voice.ok ? undefined : `speech: ${voice.reason}`);
      return {
        ok: true,
        transcript,
        reply,
        command,
        ended,
        audio: voice.ok ? voice.audio : null,
        speechError: voice.ok ? null : `turtl couldn't speak this reply (${voice.reason}), so it is on screen only.`,
      };
    } catch (error) {
      await end("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  },
});
