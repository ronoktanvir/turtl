import type { VoiceClip, VoiceReply, VoiceStatus } from "../types";

const reason = "Talking out loud isn't available here yet. Type your question instead, and turtl answers in writing.";
const status: VoiceStatus = { available: false, reason, maxClipMs: 30_000 };

export function useVoice(_caseId: string): { status: VoiceStatus | undefined; talk(clip: VoiceClip): Promise<VoiceReply> } {
  return { status, talk: async () => ({ ok: false, reason, retry: false }) };
}
