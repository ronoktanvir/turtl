import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { VoiceClip, VoiceReply, VoiceStatus } from "../types";
import { errorMessage, liveClient, useLiveQuery } from "./client";

const NO_BACKEND: VoiceStatus = { available: false, reason: "The backend URL is not configured.", maxClipMs: 30_000 };

export function useVoice(caseId: string): { status: VoiceStatus | undefined; talk(clip: VoiceClip): Promise<VoiceReply> } {
  const status = useLiveQuery(api.voice.turn.status, liveClient && caseId ? { caseId } : "skip");
  return {
    status: liveClient ? status : NO_BACKEND,
    talk: async (clip) => {
      if (!liveClient) throw new Error(NO_BACKEND.reason!);
      try {
        return await liveClient.action(api.voice.turn.talk, { caseId: caseId as Id<"cases">, ...clip });
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
  };
}
