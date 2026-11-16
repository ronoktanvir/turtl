import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, query } from "./_generated/server";
import { gateFor } from "./consent/gate";
import { vNoticeEvent, vNoticeOutcome } from "./constants";
import { sendOwnerNotice } from "./keiki";
import type { NoticeResult } from "./keiki";

export const forCase = query({
  args: { caseId: v.id("cases") },
  handler: async (ctx, { caseId }) =>
    await ctx.db
      .query("ownerNotices")
      .withIndex("by_case_and_event", (q) => q.eq("caseId", caseId))
      .collect(),
});

export const claim = internalMutation({
  args: { caseId: v.id("cases"), event: vNoticeEvent },
  handler: async (ctx, { caseId, event }): Promise<Id<"ownerNotices"> | null> => {
    const existing = await ctx.db
      .query("ownerNotices")
      .withIndex("by_case_and_event", (q) => q.eq("caseId", caseId).eq("event", event))
      .unique();
    if (existing) return null;
    if (!(await ctx.db.get(caseId))) throw new Error("Case not found.");
    return await ctx.db.insert("ownerNotices", {
      caseId,
      event,
      outcome: "pending",
      observedAt: Date.now(),
    });
  },
});

export const recordResult = internalMutation({
  args: {
    noticeId: v.id("ownerNotices"),
    outcome: vNoticeOutcome,
    status: v.optional(v.number()),
  },
  handler: async (ctx, { noticeId, outcome, status }) => {
    const notice = await ctx.db.get(noticeId);
    if (notice?.outcome !== "pending") return;
    await ctx.db.patch(noticeId, { outcome, status, observedAt: Date.now() });
  },
});

export const notifyOwner = internalAction({
  args: { caseId: v.id("cases"), event: vNoticeEvent, text: v.string() },
  handler: async (ctx, { caseId, event, text }): Promise<NoticeResult | null> => {
    const noticeId = await ctx.runMutation(internal.notices.claim, { caseId, event });
    if (!noticeId) return null;
    const result = await sendOwnerNotice(gateFor(ctx, { caseId }), text);
    await ctx.runMutation(internal.notices.recordResult, { noticeId, ...result });
    return result;
  },
});
