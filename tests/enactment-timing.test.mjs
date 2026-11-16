import assert from "node:assert/strict";
import { test } from "node:test";
import { EXAMPLE_RUN_SPEED, estimatedStepDuration, playbackDuration, readExecutionClock, changeClockState } from "../data/example/timing.ts";
import { formatDuration, remainingDuration } from "../components/execution/timing.ts";
import { approvalLabel } from "../theme/design.ts";

test("one pace constant gives realistic minutes and watchable step durations", () => {
  assert.equal(EXAMPLE_RUN_SPEED, 15);
  assert.equal(estimatedStepDuration("write"), 220_000);
  assert.equal(estimatedStepDuration("checks"), 180_000);
  assert.equal(estimatedStepDuration("open_pr"), 45_000);
  for (const key of ["baseline", "write", "open_pr", "checks", "merge", "deploy", "verify"]) {
    const playback = playbackDuration(estimatedStepDuration(key));
    assert.ok(playback >= 3000 && playback <= 15_000, key);
  }
});

test("approval wording agrees with its count", () => {
  assert.equal(approvalLabel(1), "1 needs approval");
  assert.equal(approvalLabel(2), "2 need approval");
  assert.equal(approvalLabel(4), "4 need approval");
});

test("the display clock pauses for owner decisions and resumes without jumping", () => {
  const clock = { realAt: 1000, logicalAt: 100_000, running: true };
  assert.equal(readExecutionClock(clock, 3000), 130_000);
  const paused = changeClockState(clock, false, 3000);
  assert.equal(readExecutionClock(paused, 100_000), 130_000);
  const resumed = changeClockState(paused, true, 100_000);
  assert.equal(readExecutionClock(resumed, 102_000), 160_000);
  assert.equal(clock.logicalAt, 100_000);
  assert.equal(readExecutionClock(clock, 0), 100_000);
});

test("remaining estimates exclude completed work and durations retain seconds", () => {
  assert.equal(formatDuration(220_000), "3 min 40 s");
  const steps = [
    { key: "write", title: "Write", status: "done", estimatedDurationMs: 220_000 },
    { key: "checks", title: "Checks", status: "running", startedAt: 10_000, estimatedDurationMs: 180_000 },
    { key: "merge", title: "Merge", status: "pending", estimatedDurationMs: 45_000 },
  ];
  assert.equal(remainingDuration(steps, 40_000), 195_000);
  assert.equal(remainingDuration(steps, 250_000), 45_000);
});
