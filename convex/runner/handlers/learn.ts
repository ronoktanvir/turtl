import type { StepHandler } from "../contract";
import { learnCase } from "../../memory/service";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input) => {
    const result = await learnCase(ctx, input.case._id);
    return {
      status: "done",
      summary: result.summary,
      handoff: {
        note: result.summary,
        refs: result.memoryId
          ? [{ kind: "recoveryMemory", id: result.memoryId }]
          : [],
      },
      output: result,
    };
  },
};
