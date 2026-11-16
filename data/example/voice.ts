import type { VoiceClip, VoiceReply, VoiceStatus } from "../types";

const reason = "Talking with turtl needs turtl's backend, and this build is not connected to one. Type your question instead.";
const status: VoiceStatus = { available: false, reason, maxClipMs: 30_000 };

export function useVoice(_caseId: string): { status: VoiceStatus | undefined; talk(clip: VoiceClip): Promise<VoiceReply> } {
  return { status, talk: async () => ({ ok: false, reason, retry: false }) };
}
