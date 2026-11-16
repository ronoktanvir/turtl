import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

// Reads a finished recording into memory and removes it from the device: turtl keeps no audio.
export async function readClip(uri: string): Promise<{ audio: ArrayBuffer; mimeType: string }> {
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    URL.revokeObjectURL(uri);
    return { audio: await blob.arrayBuffer(), mimeType: blob.type || "audio/webm" };
  }
  const file = new File(uri);
  try {
    const bytes = await file.bytes();
    return { audio: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mimeType: "audio/mp4" };
  } finally {
    try { file.delete(); } catch {}
  }
}

// Plays a spoken reply and resolves when it ends or when the returned stop function is called.
export function playReply(audio: ArrayBuffer): { done: Promise<void>; stop: () => void } {
  let stopped = false;
  let halt = () => { stopped = true; };
  const done = (async () => {
    let uri: string;
    let cleanup: () => void;
    if (Platform.OS === "web") {
      uri = URL.createObjectURL(new Blob([audio], { type: "audio/mpeg" }));
      cleanup = () => URL.revokeObjectURL(uri);
    } else {
      const file = new File(Paths.cache, `turtl-reply-${Date.now()}.mp3`);
      await file.write(new Uint8Array(audio));
      uri = file.uri;
      cleanup = () => { try { file.delete(); } catch {} };
    }
    const player = createAudioPlayer(uri);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        subscription.remove();
        try { player.pause(); } catch {}
        player.remove();
        cleanup();
        resolve();
      };
      const subscription = player.addListener("playbackStatusUpdate", (status) => { if (status.didJustFinish) finish(); });
      const guard = setTimeout(finish, 120_000);
      halt = finish;
      if (stopped) finish();
      else player.play();
    });
  })();
  return { done, stop: () => halt() };
}
