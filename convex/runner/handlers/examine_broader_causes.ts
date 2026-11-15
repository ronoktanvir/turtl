import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: no broader causes were examined.",
    handoff: { note: "No broader causes to pass on: this step is a placeholder.", refs: [] },
  }),
};
