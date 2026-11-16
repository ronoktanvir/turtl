import type { PlanStep } from "../../data/types";

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes} min${remainder ? ` ${remainder} s` : ""}` : `${seconds} s`;
}

/** How long a finished step took: "under a second" rather than "0 s". */
export function tookDuration(milliseconds: number): string {
  return milliseconds < 1000 ? "under a second" : formatDuration(milliseconds);
}

export function formatStart(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function remainingDuration(steps: PlanStep[], now: number): number | undefined {
  let remaining = 0;
  for (const step of steps) {
    if (step.status === "done" || step.status === "skipped") continue;
    if (step.estimatedDurationMs === undefined) return undefined;
    const elapsed = step.status === "running" && step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : 0;
    remaining += Math.max(0, step.estimatedDurationMs - elapsed);
  }
  return remaining;
}
