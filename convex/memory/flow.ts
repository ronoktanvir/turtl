import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { ParameterValue } from "../constants";
import { loadSteps, skipStep } from "../workflow";
import { applicability } from "./checks";
import { sourceEvidenceValid } from "./records";

export async function matchRecovery(
  ctx: MutationCtx,
  attemptId: Id<"stepAttempts">,
  memoryId: Id<"recoveryMemories">,
  facts: Record<string, ParameterValue>,
) {
  const attempt = await ctx.db.get(attemptId);
  const step = attempt ? await ctx.db.get(attempt.stepId) : null;
  const row = attempt ? await ctx.db.get(attempt.caseId) : null;
  const memory = await ctx.db.get(memoryId);
  if (
    !attempt ||
    !step ||
    !row ||
    step.purpose !== "gather_context" ||
    step.currentAttemptId !== attemptId ||
    attempt.status !== "running" ||
    ["declined", "unresolved", "resolved"].includes(row.status)
  )
    return false;
  if (
    !memory ||
    memory.appId !== row.appId ||
    memory.signature !== row.signature ||
    !applicability(memory, facts).applies ||
    !(await sourceEvidenceValid(ctx, memory))
  )
    return false;
  const steps = await loadSteps(ctx, row._id);
  const investigation = steps.filter((item) => item.purpose === "investigate");
  if (
    investigation.some(
      (item) =>
        item.status !== "pending" &&
        item.status !== "failed" &&
        !(item.status === "skipped" && item.skipReason?.includes(memoryId)),
    )
  )
    return false;
  await ctx.db.patch(row._id, { matchedMemoryId: memoryId });
  for (const item of investigation) {
    if (item.status !== "skipped")
      await skipStep(
        ctx,
        item._id,
        `Recovery memory ${memoryId} applies after its conditions were rechecked against fresh observations. Verification and owner approval are still required.`,
      );
  }
  return true;
}
