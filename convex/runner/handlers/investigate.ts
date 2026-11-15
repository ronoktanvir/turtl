import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: no investigation ran.",
    handoff: { note: "No findings to pass on: investigation is a placeholder.", refs: [] },
  }),
};
