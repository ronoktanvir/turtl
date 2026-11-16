import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalQuery, type MutationCtx } from "../_generated/server";
import { loadSteps } from "../workflow";
import { conditionsOf, fingerprint, turnedDownFrom, type Facts } from "./rules";

const MAX_NOTE_LENGTH = 500;
const HISTORY_LIMIT = 10;

export const vDecisionNote = v.optional(v.string());

// Records what turtl recommended against what the owner did, in the same transaction as the decision.
// A note that may state a preference is read afterwards and only ever suggested back to the owner.
export async function recordDecision(
  ctx: MutationCtx,
  proposal: Doc<"proposals">,
  decision: { outcome: "approved" | "declined" | "stopped"; chosenKey?: string; note?: string },
) {
  const row = await ctx.db.get(proposal.caseId);
  if (!row) return null;
  const facts = ((await loadSteps(ctx, row._id)).find((s) => s.purpose === "gather_context")?.currentAttempt?.output
    ?.facts ?? null) as Facts | null;
  const conditions = conditionsOf(row.signature, facts);
  const recommended = proposal.options.find((o) => o.recommended);
  const chosen = decision.chosenKey ? proposal.options.find((o) => o.key === decision.chosenKey) : undefined;
  const outcome =
    decision.outcome === "approved" && recommended && chosen && chosen.key !== recommended.key ? "chose_other" : decision.outcome;
  const turnedDown = outcome === "stopped" ? chosen : outcome === "approved" ? undefined : recommended;
  const note = decision.note?.trim().slice(0, MAX_NOTE_LENGTH) || undefined;
  const id = await ctx.db.insert("ownerDecisions", {
    appId: row.appId,
    caseId: row._id,
    proposalId: proposal._id,
    proposalVersion: proposal.version,
    outcome,
    ...(recommended && { recommendedKey: recommended.key, recommendedTitle: recommended.title }),
    ...(chosen && { chosenKey: chosen.key, chosenTitle: chosen.title }),
    ...(turnedDown && { turnedDownTitle: turnedDown.title, turnedDownFingerprint: fingerprint(turnedDown) }),
    conditionsKey: conditions.key,
    conditionsText: conditions.text,
    ...(note && { note }),
    decidedAt: Date.now(),
  });
  if (note) {
    if (outcome !== "stopped") await ctx.db.patch(proposal._id, { ownerNote: note });
    await ctx.scheduler.runAfter(0, internal.learning.preferences.suggestFromNote, { decisionId: id });
  }
  return id;
}

// How the owner decided earlier cases on this app: those under the same conditions, folded into how often
// each option was turned down, and the most recent decisions for the model to read.
export const history = internalQuery({
  args: { appId: v.id("apps"), caseId: v.id("cases"), conditionsKey: v.string() },
  handler: async (ctx, { appId, caseId, conditionsKey }) => {
    const same = (
      await ctx.db
        .query("ownerDecisions")
        .withIndex("by_app_and_conditions", (q) => q.eq("appId", appId).eq("conditionsKey", conditionsKey))
        .collect()
    ).filter((d) => d.caseId !== caseId);
    const recent = (
      await ctx.db
        .query("ownerDecisions")
        .withIndex("by_app", (q) => q.eq("appId", appId))
        .order("desc")
        .take(HISTORY_LIMIT + 1)
    ).filter((d) => d.caseId !== caseId).slice(0, HISTORY_LIMIT);
    return {
      turnedDown: turnedDownFrom(same),
      sameConditionsCount: same.length,
      recent: recent.map((d) => ({
        sameConditions: d.conditionsKey === conditionsKey,
        conditions: d.conditionsText,
        recommended: d.recommendedTitle ?? null,
        ownerDid: d.outcome,
        chose: d.chosenTitle ?? null,
        note: d.note ?? null,
      })),
    };
  },
});
