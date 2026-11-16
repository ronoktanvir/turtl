import type { StepHandler } from "../contract";
import { learnCase, writeCaseNote } from "../../memory/service";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input) => {
    const result = await learnCase(ctx, input.case._id);
    const caseNote = input.case.journeyId
      ? await writeCaseNote(ctx, input.case._id, result.summary).catch(() => ({
          note: result.summary,
          summary: "No case note was saved because building it failed.",
        }))
      : null;
    return {
      status: "done",
      summary: caseNote
        ? `${result.summary} ${caseNote.summary}`
        : result.summary,
      handoff: {
        note: caseNote?.note ?? result.summary,
        refs: result.memoryId
          ? [{ kind: "recoveryMemory", id: result.memoryId }]
          : [],
      },
      output: result,
    };
  },
};
