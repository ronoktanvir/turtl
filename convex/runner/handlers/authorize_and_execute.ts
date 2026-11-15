import type { StepHandler } from "../contract";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async () => ({
    status: "done",
    summary: "Placeholder: the owner approved, but nothing was executed.",
    handoff: { note: "Nothing ran: execution is a placeholder.", refs: [] },
  }),
};
