import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 15_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: no check ran, so nothing was verified.",
    handoff: { note: "No verification result: verification is a placeholder.", refs: [] },
  }),
};
