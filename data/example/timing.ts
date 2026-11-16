export const EXAMPLE_RUN_SPEED = 15;

const durations: Record<string, number> = {
  baseline: 90_000,
  write: 220_000,
  open_pr: 45_000,
  checks: 180_000,
  merge: 45_000,
  verify: 90_000,
};

export function estimatedStepDuration(key: string): number {
  return durations[key] ?? 120_000;
}

export type ExecutionClock = { realAt: number; logicalAt: number; running: boolean };

export function readExecutionClock(clock: ExecutionClock, realNow: number): number {
  return clock.logicalAt + (clock.running ? Math.max(0, realNow - clock.realAt) * EXAMPLE_RUN_SPEED : 0);
}

export function changeClockState(clock: ExecutionClock, running: boolean, realNow: number): ExecutionClock {
  return { realAt: realNow, logicalAt: readExecutionClock(clock, realNow), running };
}

export function playbackDuration(logicalMilliseconds: number): number {
  return Math.max(0, logicalMilliseconds) / EXAMPLE_RUN_SPEED;
}
