// Turn-taking for a hands-free voice conversation, from the recorder's level readings. Pure, so tests load it.

export const SPEECH_DB = -42;
export const MIN_SPEECH_MS = 300;
export const END_SILENCE_MS = 1_400;

export type Ear = { speechMs: number; lastLoudMs: number | null; lastMs: number | null; heard: boolean };
export const freshEar = (): Ear => ({ speechMs: 0, lastLoudMs: null, lastMs: null, heard: false });

// One level reading at a point in the recording. "send" ends the turn after the owner spoke and then paused,
// or at the clip limit; "give_up" means the clip limit passed with no speech at all.
export function hear(ear: Ear, sample: { durationMs: number; db: number | undefined }, maxClipMs: number): { ear: Ear; next: "listen" | "send" | "give_up" } {
  const at = sample.durationMs;
  const elapsed = ear.lastMs === null ? 0 : Math.max(0, at - ear.lastMs);
  const loud = sample.db !== undefined && sample.db > SPEECH_DB;
  const speechMs = ear.speechMs + (loud ? elapsed : 0);
  const next: Ear = { speechMs, lastLoudMs: loud ? at : ear.lastLoudMs, lastMs: at, heard: speechMs >= MIN_SPEECH_MS };
  if (at >= maxClipMs - 250) return { ear: next, next: next.heard ? "send" : "give_up" };
  if (next.heard && next.lastLoudMs !== null && at - next.lastLoudMs >= END_SILENCE_MS) return { ear: next, next: "send" };
  return { ear: next, next: "listen" };
}

// The input level from 0 to 1 for the listening meter.
export const levelOf = (db: number | undefined) => db === undefined ? 0 : Math.min(1, Math.max(0, (db + 60) / 50));
