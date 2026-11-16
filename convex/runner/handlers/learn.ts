import { internal } from "../../_generated/api";
import type { StepHandler } from "../contract";
import { learnCase, writeCaseNote } from "../../memory/service";

export const handler: StepHandler = {
  timeoutMs: 60_000,
  run: async (ctx, input) => {
    const result = await learnCase(ctx, input.case._id);
    const context = await ctx
      .runMutation(internal.learning.context.markForCase, { caseId: input.case._id })
      .catch(() => ({ summary: "Context learning failed, so no source was marked as helpful." }));
    const summary = `${result.summary} ${context.summary}`;
    const caseNote = input.case.journeyId
      ? await writeCaseNote(ctx, input.case._id, summary).catch(() => ({
          note: summary,
          summary: "No case note was saved because building it failed.",
        }))
      : null;
    return {
      status: "done",
      summary: caseNote ? `${summary} ${caseNote.summary}` : summary,
      handoff: {
        note: caseNote?.note ?? summary,
        refs: result.memoryId
          ? [{ kind: "recoveryMemory", id: result.memoryId }]
          : [],
      },
      output: { ...result, context },
    };
  },
};
