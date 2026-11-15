import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { describeCheck, recoveryChecks } from "./memory/checks";
import { loadSteps } from "./workflow";

// Test fixtures for the permission flow, used until the memory thread's recall sets matchedMemoryId on its
// own. Internal only: run them with `npx convex run` against a local deployment.

// Writes a recovery memory from a restored case, the way learn would, with the given verified count.
export const seedMemory = internalMutation({
  args: { caseId: v.id("cases"), timesVerified: v.number() },
  handler: async (ctx, { caseId, timesVerified }): Promise<Id<"recoveryMemories">> => {
    const row = await ctx.db.get(caseId);
    if (!row?.signature) throw new Error("The case has no signature.");
    const facts =
      ((await loadSteps(ctx, caseId)).find((s) => s.purpose === "gather_context")?.currentAttempt?.output as
        | { facts?: Record<string, unknown> }
        | undefined)?.facts ?? {};
    const checks = recoveryChecks(facts);
    if (!checks) throw new Error("The case's facts do not describe the recommendations outage.");
    const verification = (
      await ctx.db
        .query("verifications")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .collect()
    )
      .filter((r) => r.phase === "after_fix" && r.verdict === "passed" && r.actionId)
      .pop();
    if (!verification) throw new Error("The case has no passing after-fix verification.");
    const action = await ctx.db.get(verification.actionId!);
    if (!action) throw new Error("The verified action was not found.");
    const notWhenChecks = checks.map((check) => ({ ...check, operator: "neq" as const }));
    return await ctx.db.insert("recoveryMemories", {
      appId: row.appId,
      sourceCaseId: caseId,
      signature: row.signature,
      symptoms: `${row.title}. ${row.impact}`,
      cause: "The recommendations step timed out while recommendations were enabled and the service health check passed.",
      actionType: action.type,
      verificationId: verification._id,
      appRevision: String(facts["app.revision"]),
      conditions: checks.map(describeCheck),
      conditionChecks: checks,
      notWhen: notWhenChecks.map(describeCheck),
      notWhenChecks,
      timesApplied: timesVerified,
      timesVerified,
    });
  },
});

export const setTimesVerified = internalMutation({
  args: { memoryId: v.id("recoveryMemories"), timesVerified: v.number() },
  handler: async (ctx, { memoryId, timesVerified }) => {
    await ctx.db.patch(memoryId, { timesVerified, timesApplied: timesVerified });
  },
});

// Stands in for recall: marks a freshly opened case as matching the memory before it reaches approval.
export const matchCase = internalMutation({
  args: { caseId: v.id("cases"), memoryId: v.id("recoveryMemories") },
  handler: async (ctx, { caseId, memoryId }) => {
    await ctx.db.patch(caseId, { matchedMemoryId: memoryId });
  },
});
