import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 15_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: no logs, deploys or history were gathered.",
    handoff: { note: "No context to pass on: gathering is a placeholder.", refs: [] },
  }),
};
