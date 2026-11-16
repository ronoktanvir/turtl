import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useVoice } from "../../data";
import { playReply, readClip } from "./clip";
import { freshEar, hear, levelOf } from "./ear";

const OPTIONS: RecordingOptions = {
  ...RecordingPresets.LOW_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
  web: { mimeType: "audio/webm", bitsPerSecond: 64_000 },
};

export type TalkPhase = "idle" | "starting" | "listening" | "thinking" | "speaking";
export type TalkSession = {
  phase: TalkPhase;
  active: boolean;
  available: boolean;
  heard: boolean;
  level: number;
  notice: string | null;
  start(): void;
  end(): void;
  next(): void;
};

const announce = (message: string) => AccessibilityInfo.announceForAccessibility?.(message);
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong with the conversation.";

// A hands-free conversation about one case: listen, send the clip when the owner pauses, speak the reply,
// then listen again, until the owner ends it. Each reply also lands in the case chat as text.
export function useTalkSession(caseId: string, onReply?: () => void): TalkSession {
  const voice = useVoice(caseId);
  const recorder = useAudioRecorder(OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<TalkPhase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [heard, setHeard] = useState(false);
  const session = useRef(0);
  const recording = useRef(false);
  const ear = useRef(freshEar());
  const duration = useRef(0);
  const playback = useRef<(() => void) | null>(null);
  const latest = useRef({ voice, onReply });
  latest.current = { voice, onReply };
  const maxClipMs = voice.status?.maxClipMs ?? 30_000;

  const release = async () => {
    if (!recording.current) return;
    recording.current = false;
    try { await recorder.stop(); } catch {}
  };

  const end = async (reason: string | null) => {
    session.current += 1;
    playback.current?.();
    playback.current = null;
    await release();
    setPhase("idle");
    setHeard(false);
    setNotice(reason);
    announce(reason ?? "Conversation ended");
    setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  };

  const listen = async (id: number) => {
    ear.current = freshEar();
    duration.current = 0;
    setHeard(false);
    await recorder.prepareToRecordAsync();
    if (session.current !== id) return;
    recorder.record();
    recording.current = true;
    setPhase("listening");
    announce("turtl is listening");
  };

  const turn = async (id: number) => {
    if (!recording.current || session.current !== id) return;
    recording.current = false;
    setPhase("thinking");
    announce("turtl is thinking");
    try {
      await recorder.stop();
      if (!recorder.uri) throw new Error("The recording was empty.");
      const clip = await readClip(recorder.uri);
      const result = await latest.current.voice.talk({ ...clip, durationMs: duration.current });
      if (session.current !== id) return;
      if (!result.ok) {
        if (!result.retry) return void (await end(result.reason));
        setNotice(result.reason);
        announce(result.reason);
        return void (await listen(id));
      }
      setNotice(result.speechError);
      latest.current.onReply?.();
      if (result.audio) {
        setPhase("speaking");
        const reply = playReply(result.audio);
        playback.current = reply.stop;
        await reply.done;
        playback.current = null;
      } else {
        announce(result.reply);
      }
      if (session.current !== id) return;
      if (result.ended) return void (await end(null));
      await listen(id);
    } catch (error) {
      if (session.current === id) await end(message(error));
    }
  };

  useEffect(() => {
    if (phase !== "listening" || !recording.current) return;
    duration.current = recorderState.durationMillis;
    const result = hear(ear.current, { durationMs: recorderState.durationMillis, db: recorderState.metering }, maxClipMs);
    ear.current = result.ear;
    if (result.ear.heard !== heard) setHeard(result.ear.heard);
    if (result.next === "send") void turn(session.current);
    if (result.next === "give_up") void end(`turtl stopped listening: it heard no question for ${Math.round(maxClipMs / 1000)} seconds.`);
  }, [recorderState]);

  useEffect(() => () => {
    session.current += 1;
    playback.current?.();
    if (recording.current) recorder.stop().catch(() => {});
  }, []);

  const start = async () => {
    if (phase !== "idle") return;
    if (!voice.status?.available) {
      setNotice(voice.status?.reason ?? "turtl is still checking whether it can talk on this backend. Try again in a moment.");
      return;
    }
    const id = ++session.current;
    setNotice(null);
    setPhase("starting");
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (session.current !== id) return;
      if (!permission.granted) return void (await end("turtl needs microphone access to listen. Allow it in Settings, or type your question."));
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (session.current !== id) return;
      await listen(id);
    } catch (error) {
      if (session.current === id) await end(message(error));
    }
  };

  return {
    phase,
    active: phase !== "idle",
    available: voice.status?.available ?? false,
    heard,
    level: phase === "listening" ? levelOf(recorderState.metering) : 0,
    notice,
    start: () => void start(),
    end: () => void end(null),
    next: () => {
      if (phase === "listening") void turn(session.current);
      if (phase === "speaking") playback.current?.();
    },
  };
}
