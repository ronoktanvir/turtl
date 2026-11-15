import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: no plan was made, so there is no specific action to approve.",
    handoff: { note: "No plan to pass on: planning is a placeholder.", refs: [] },
  }),
};
