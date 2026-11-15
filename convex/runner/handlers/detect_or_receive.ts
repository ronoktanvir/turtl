import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 15_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: nothing was detected or received; the case was started directly.",
    handoff: { note: "No signal to pass on: detection is a placeholder.", refs: [] },
  }),
};
