import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { joinSnapshots } from "./snapshots";

export const projectEvidence = internalMutation({
  args: { attemptId: v.id("stepAttempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || (attempt.status !== "running" && attempt.status !== "done")) {
      throw new Error("Only a running or completed gather attempt can project evidence.");
    }
    const [row, step] = await Promise.all([ctx.db.get(attempt.caseId), ctx.db.get(attempt.stepId)]);
    if (!row || !step) throw new Error("Gather case or step is missing.");
    const parents = await Promise.all((attempt.inputRefs ?? []).map(async (id) => {
      const parentAttempt = await ctx.db.get(id);
      if (!parentAttempt) throw new Error("Consumed collector attempt is missing.");
      const parentStep = await ctx.db.get(parentAttempt.stepId);
      if (!parentStep) throw new Error("Consumed collector step is missing.");
      return { step: parentStep, attempt: parentAttempt };
    }));
    const [evidence, projections] = await Promise.all([
      ctx.db.query("evidence").withIndex("by_case", (q) => q.eq("caseId", row._id)).collect(),
      ctx.db.query("evidence").withIndex("by_attempt", (q) => q.eq("stepAttemptId", attemptId)).collect(),
    ]);
    const consumed = joinSnapshots({ case: row, step, attempt, parents, previousAttempts: [], idempotencyKey: `projection:${attemptId}`, approval: null }, { evidence });
    const refs = [];
    for (const ref of consumed.refs) {
      const original = evidence.find((entry) => entry._id === ref.id)!;
      const sourceRef = `Derived from evidence/${original._id}; stepAttempts/${original.stepAttemptId}; ${original.sourceRef}`;
      const existing = projections.filter((entry) => entry.sourceRef === sourceRef);
      if (existing.length > 1) throw new Error("Duplicate gather evidence projections already exist.");
      const projection = {
        caseId: row._id,
        stepId: step._id,
        stepAttemptId: attemptId,
        kind: original.kind,
        title: original.title,
        ...(original.body !== undefined && { body: original.body }),
        ...(original.url !== undefined && { url: original.url }),
        sourceRef,
        observedAt: original.observedAt,
        environment: original.environment,
        revision: original.revision,
      };
      if (existing[0]) {
        const saved = existing[0];
        if (saved.caseId !== projection.caseId || saved.stepId !== projection.stepId || saved.kind !== projection.kind || saved.title !== projection.title || saved.body !== projection.body || saved.url !== projection.url || saved.observedAt !== projection.observedAt || saved.environment !== projection.environment || saved.revision.commitSha !== projection.revision.commitSha || saved.revision.buildId !== projection.revision.buildId || saved.revision.deploymentId !== projection.revision.deploymentId) {
          throw new Error("Gather evidence projection differs from its original evidence.");
        }
      }
      const id = existing[0]?._id ?? await ctx.db.insert("evidence", projection);
      refs.push({ kind: "evidence" as const, id, label: original.kind });
    }
    return refs;
  },
});
