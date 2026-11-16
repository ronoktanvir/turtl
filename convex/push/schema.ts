import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vNoticeEvent } from "../constants";

export const vPushPlatform = v.union(v.literal("ios"), v.literal("android"));

/** Why a token stopped receiving: Expo said the phone no longer accepts it, or a newer phone took its place. */
export const vDisabledReason = v.union(v.literal("not_registered"), v.literal("replaced"));

/** What came of one push for one case event. "sent" means Expo accepted it for every phone, not that a phone showed it. */
export const vPushOutcome = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("partly_sent"),
  v.literal("failed"),
);

export const vPushTicket = v.object({
  tokenId: v.id("pushTokens"),
  /** Expo's receipt id when it accepted the message. */
  receiptId: v.optional(v.string()),
  /** Expo's error code (for example DeviceNotRegistered), from the ticket or later from the receipt. */
  error: v.optional(v.string()),
  receipt: v.optional(v.union(v.literal("ok"), v.literal("error"))),
});

export const pushTables = {
  // One row per phone that asked for notifications. A token lives under the account that registered it last.
  pushTokens: defineTable({
    account: v.string(),
    /** Expo push token, "ExponentPushToken[…]". It identifies a phone, so it is collected data (Device ID). */
    token: v.string(),
    platform: vPushPlatform,
    addedAt: v.number(),
    lastSeenAt: v.number(),
    disabledAt: v.optional(v.number()),
    disabledReason: v.optional(vDisabledReason),
    /** With accounts on: the sign-in session that registered this phone. It receives the account's notifications only
     * while that session is live (convex/push/devices.ts, receives). */
    sessionId: v.optional(v.id("authSessions")),
    /** With accounts on: registered by a caller whose token names no session (an identity the operator's admin key
     * stands for), so it is live until removed, as every phone was before sessions were kept. */
    noSession: v.optional(v.literal(true)),
  })
    .index("by_token", ["token"])
    .index("by_account_and_disabled", ["account", "disabledAt"]),
  // The push outcome of one owner notice (convex/notices.ts), next to its text outcome. Written only when a phone was there to send to.
  pushSends: defineTable({
    noticeId: v.id("ownerNotices"),
    caseId: v.id("cases"),
    event: vNoticeEvent,
    account: v.string(),
    outcome: vPushOutcome,
    status: v.optional(v.number()),
    tickets: v.array(vPushTicket),
    sentAt: v.number(),
    receiptsCheckedAt: v.optional(v.number()),
  })
    .index("by_notice", ["noticeId"])
    .index("by_case", ["caseId"]),
};
