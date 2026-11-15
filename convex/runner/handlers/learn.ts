import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 15_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: nothing was saved to memory.",
    handoff: { note: "Nothing was remembered: learning is a placeholder.", refs: [] },
  }),
};
