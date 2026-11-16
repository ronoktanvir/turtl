// Pure rules for talking with turtl about a case. No Convex imports, so tests load this file directly.

export const MAX_CLIP_MS = 30_000;
export const MAX_CLIP_BYTES = 1_000_000;
export const RATE_WINDOW_MS = 10 * 60_000;
export const MAX_TURNS_PER_WINDOW = 20;
export const MAX_SPOKEN_CHARS = 1_200;

const CLIP_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

// The file extension OpenAI needs for a recorded clip, or null when the type is not one turtl accepts.
export function clipExtension(mimeType: string): string | null {
  return CLIP_TYPES[mimeType.split(";")[0].trim().toLowerCase()] ?? null;
}

// Why voice cannot run on this backend, in the owner's words, or null when it can.
export function unavailableReason(env: { VOICE_ENABLED?: string; OPENAI_API_KEY?: string }): string | null {
  if (env.VOICE_ENABLED !== "true") return "Talking with turtl is switched off on this backend. Type your question instead.";
  if (!env.OPENAI_API_KEY) return "Talking with turtl needs an OpenAI key on this backend, and none is set. Type your question instead.";
  return null;
}

export type OwnerCommand = "approve" | "decline" | "merge" | "stop";

const GOODBYE = /^(ok(ay)? |thanks |thank you |great )*(stop listening|that'?s all|that is all|that'?s it|that is it|good ?bye|bye|i'?m done|we'?re done|end (the |this )?(conversation|session|call|chat))( thanks| thank you| turtl)*$/;

// The owner ending a hands-free conversation by voice ("that's all", "stop listening").
export function endsConversation(transcript: string): boolean {
  return GOODBYE.test(transcript.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z'\s]/g, " ").replace(/\s+/g, " ").trim());
}

const QUESTION = /^(what|why|how|when|where|who|which|whose|should|shall|is|are|was|were|do|does|did|has|have|had|if|tell me|explain)\b/;
const REQUEST = /^(please |ok(ay)? |yes |yeah |alright |turtl )*(can you|could you|would you|will you|go and|just)\b/;
const COMMANDS: [OwnerCommand, RegExp][] = [
  ["decline", /\b(decline|reject|deny|refuse|(do not|don'?t|never) (approve|do it|run it|apply it|merge))\b/],
  ["merge", /\bmerge\b/],
  ["stop", /\b(stop|cancel|abort|halt|kill|undo|roll (it |that |this |the fix )?back|rollback|revert)\b/],
  ["approve", /\b(approve[ds]?|accept|authori[sz]e|confirm|go ahead|do it|do that|ship it|apply (it|that|the fix|fix \w+)|run (it|that|the fix)|green ?light|let'?s do it|yes,? (do|go|approve))\b/],
];

// A spoken instruction to make an owner decision (approve, decline, merge, stop). Speech never makes one,
// so the caller answers with where the button is. A question about a decision ("should I approve fix 2?")
// is not a command and goes to the case chat, which cannot act either.
export function ownerCommand(transcript: string): OwnerCommand | null {
  const text = transcript.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9'?\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const asks = text.endsWith("?") || QUESTION.test(text);
  if (asks && !REQUEST.test(text)) return null;
  return COMMANDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

export const COMMAND_REPLIES: Record<OwnerCommand, string> = {
  approve: "I can't approve anything from a conversation, so nothing was approved. To approve a fix, tap Approve on it, on the Fixes screen or on a fix in this chat, then enter your passcode.",
  decline: "I can't decline a fix from a conversation, so nothing changed. Nothing runs until you tap Approve on a fix and enter your passcode.",
  merge: "I can't merge from a conversation, so nothing was merged. When the checks pass, tap Merge on the Fix enacting screen.",
  stop: "I can't stop or undo anything from a conversation, so nothing was stopped. To stop a fix that is running, tap Stop on the Fix enacting screen.",
};

// The part of a reply that is spoken: whole sentences up to the limit. The full reply stays in the thread.
export function spokenText(reply: string): string {
  const text = reply.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let spoken = "";
  for (const sentence of sentences) {
    if ((spoken + sentence).length > MAX_SPOKEN_CHARS - 40) break;
    spoken += sentence;
  }
  return `${(spoken || text.slice(0, MAX_SPOKEN_CHARS - 40)).trim()} The rest is on screen.`;
}
