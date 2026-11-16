import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { accessEnforced, demoHoldsAccounts, ownsApp, SOLO_ACCOUNT } from "../access";
import { vNoticeEvent } from "../constants";
import { MAX_LIVE_TOKENS, receives } from "./devices";
import { NOT_REGISTERED, receiptsFromExpo, sendToExpo } from "./expo";
import { expoMessages, pushMessage, sendsPush } from "./message";
import { vPushOutcome } from "./schema";

// Sends one push per owner notice to every live phone of the project's owner, through Expo's push service. With
// accounts on, a live phone is one whose sign-in session is still live (devices.ts, receives).
// convex/notices.ts schedules forNotice once per case event, after it claimed that event; identity does not travel
// here, so the recipient is the owner on record for the case's project (apps.ownerId), never the caller.

/** Expo asks to read receipts about 15 minutes after sending; it keeps them for 24 hours. */
export const RECEIPT_DELAY_MS = 15 * 60_000;
const MAX_RECEIPT_CHECKS = 2;

type PushOutcome = "pending" | "sent" | "partly_sent" | "failed";
type Plan = { projectName: string; account: string; tokens: { tokenId: Id<"pushTokens">; token: string }[] };

export const recipients = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.null(),
    v.object({
      projectName: v.string(),
      account: v.string(),
      tokens: v.array(v.object({ tokenId: v.id("pushTokens"), token: v.string() })),
    }),
  ),
  handler: async (ctx, { caseId }) => {
    // The single-owner demo on a deployment that holds accounts notifies nobody (convex/access.ts).
    if (await demoHoldsAccounts(ctx)) return null;
    const row = await ctx.db.get(caseId);
    const app = row ? await ctx.db.get(row.appId) : null;
    if (!app) return null;
    const account = app.ownerId ?? (accessEnforced() ? undefined : SOLO_ACCOUNT);
    if (!account || !ownsApp(app, account)) return null;
    const live = await ctx.db
      .query("pushTokens")
      .withIndex("by_account_and_disabled", (q) => q.eq("account", account).eq("disabledAt", undefined))
      .take(MAX_LIVE_TOKENS);
    const receiving = [];
    for (const row of live) if (await receives(ctx, row)) receiving.push({ tokenId: row._id, token: row.token });
    return { projectName: app.name, account, tokens: receiving };
  },
});

/** One push record per owner notice: a second call for the same notice sends nothing. */
export const claimSend = internalMutation({
  args: { noticeId: v.id("ownerNotices"), caseId: v.id("cases"), event: vNoticeEvent, account: v.string(), tokenIds: v.array(v.id("pushTokens")) },
  returns: v.union(v.null(), v.id("pushSends")),
  handler: async (ctx, { noticeId, caseId, event, account, tokenIds }) => {
    const existing = await ctx.db.query("pushSends").withIndex("by_notice", (q) => q.eq("noticeId", noticeId)).first();
    if (existing) return null;
    return await ctx.db.insert("pushSends", {
      noticeId,
      caseId,
      event,
      account,
      outcome: "pending",
      tickets: tokenIds.map((tokenId) => ({ tokenId })),
      sentAt: Date.now(),
    });
  },
});

async function disableNotRegistered(ctx: MutationCtx, tokenId: Id<"pushTokens">, sentAt: number) {
  const token = await ctx.db.get(tokenId);
  // A phone that registered again after this send keeps its token.
  if (!token || token.disabledAt !== undefined || token.lastSeenAt > sentAt) return;
  await ctx.db.patch(tokenId, { disabledAt: Date.now(), disabledReason: "not_registered" });
}

const vTicketResult = v.object({ receiptId: v.optional(v.string()), error: v.optional(v.string()) });

export const recordSend = internalMutation({
  args: { sendId: v.id("pushSends"), status: v.optional(v.number()), results: v.union(v.null(), v.array(vTicketResult)) },
  returns: vPushOutcome,
  handler: async (ctx, { sendId, status, results }) => {
    const send = await ctx.db.get(sendId);
    if (!send) return "failed";
    if (!results || results.length !== send.tickets.length) {
      await ctx.db.patch(sendId, { outcome: "failed", status });
      return "failed";
    }
    const tickets = send.tickets.map((ticket, i) => ({ ...ticket, ...results[i] }));
    for (const ticket of tickets) if (ticket.error === NOT_REGISTERED) await disableNotRegistered(ctx, ticket.tokenId, send.sentAt);
    const accepted = tickets.filter((ticket) => ticket.receiptId).length;
    const outcome = accepted === tickets.length ? "sent" : accepted > 0 ? "partly_sent" : "failed";
    await ctx.db.patch(sendId, { outcome, status, tickets });
    if (accepted > 0) await ctx.scheduler.runAfter(RECEIPT_DELAY_MS, internal.push.deliver.checkReceipts, { sendId, attempt: 1 });
    return outcome;
  },
});

export const receiptIds = internalQuery({
  args: { sendId: v.id("pushSends") },
  returns: v.array(v.string()),
  handler: async (ctx, { sendId }) => {
    const send = await ctx.db.get(sendId);
    if (!send || send.receiptsCheckedAt !== undefined) return [];
    return send.tickets.flatMap((ticket) => (ticket.receiptId && !ticket.receipt ? [ticket.receiptId] : []));
  },
});

export const recordReceipts = internalMutation({
  args: {
    sendId: v.id("pushSends"),
    receipts: v.array(v.object({ receiptId: v.string(), ok: v.boolean(), error: v.optional(v.string()) })),
  },
  returns: v.null(),
  handler: async (ctx, { sendId, receipts }) => {
    const send = await ctx.db.get(sendId);
    if (!send || send.receiptsCheckedAt !== undefined) return null;
    const byId = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
    const tickets: (typeof send.tickets)[number][] = [];
    for (const ticket of send.tickets) {
      const receipt = ticket.receiptId ? byId.get(ticket.receiptId) : undefined;
      if (!receipt) { tickets.push(ticket); continue; }
      if (receipt.error === NOT_REGISTERED) await disableNotRegistered(ctx, ticket.tokenId, send.sentAt);
      tickets.push({ ...ticket, receipt: receipt.ok ? "ok" : "error", ...(receipt.error ? { error: receipt.error } : {}) });
    }
    await ctx.db.patch(sendId, { tickets, receiptsCheckedAt: Date.now() });
    return null;
  },
});

/** Scheduled by convex/notices.ts for each owner notice. Never throws; the text notice does not wait on it. */
export const forNotice = internalAction({
  args: { noticeId: v.id("ownerNotices"), caseId: v.id("cases"), event: vNoticeEvent },
  returns: v.union(v.null(), vPushOutcome),
  handler: async (ctx, { noticeId, caseId, event }): Promise<PushOutcome | null> => {
    if (!sendsPush(event)) return null;
    const plan: Plan | null = await ctx.runQuery(internal.push.deliver.recipients, { caseId });
    if (!plan || plan.tokens.length === 0) return null;
    const content = pushMessage({ projectName: plan.projectName, caseId, event });
    if (!content) return null;
    const sendId: Id<"pushSends"> | null = await ctx.runMutation(internal.push.deliver.claimSend, {
      noticeId,
      caseId,
      event,
      account: plan.account,
      tokenIds: plan.tokens.map((t) => t.tokenId),
    });
    if (!sendId) return null;
    const sent = await sendToExpo(expoMessages(content, plan.tokens.map((t) => t.token)));
    return await ctx.runMutation(internal.push.deliver.recordSend, {
      sendId,
      status: sent.status,
      results: sent.ok
        ? sent.tickets.map((ticket) => (ticket.ok ? { ...(ticket.receiptId ? { receiptId: ticket.receiptId } : {}) } : { error: ticket.error }))
        : null,
    });
  },
});

/** Reads Expo's receipts for one send and turns off the phones Expo says no longer accept notifications. */
export const checkReceipts = internalAction({
  args: { sendId: v.id("pushSends"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { sendId, attempt = 1 }): Promise<null> => {
    const ids: string[] = await ctx.runQuery(internal.push.deliver.receiptIds, { sendId });
    if (ids.length === 0) return null;
    const result = await receiptsFromExpo(ids);
    if (!result.ok) {
      if (attempt < MAX_RECEIPT_CHECKS) {
        await ctx.scheduler.runAfter(RECEIPT_DELAY_MS, internal.push.deliver.checkReceipts, { sendId, attempt: attempt + 1 });
      } else {
        await ctx.runMutation(internal.push.deliver.recordReceipts, { sendId, receipts: [] });
      }
      return null;
    }
    const receipts = Object.entries(result.receipts).map(([receiptId, receipt]) =>
      receipt.ok ? { receiptId, ok: true } : { receiptId, ok: false, error: receipt.error },
    );
    await ctx.runMutation(internal.push.deliver.recordReceipts, { sendId, receipts });
    return null;
  },
});
