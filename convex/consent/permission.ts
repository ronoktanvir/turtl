import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { type QueryCtx } from "../_generated/server";
import { mutation, query } from "../functions";
import { accessEnforced, currentAccount, requireAccount } from "../access";
import { ALSO_USED, ASKED, LIST_VERSION, standingOf, type Agreement } from "./services";

// The owner's answer on the AI permission screen (app/ai-permission.tsx), and the status the app reads to decide
// whether to show it. What is enforced lives in gate.ts; this file only records the answer.

export const LIST_CHANGED = "turtl's list of services changed while you were reading it. Read it again, then choose.";

/** The answer in force for an account: its newest row. */
export async function latestAgreement(ctx: Pick<QueryCtx, "db">, account: string): Promise<Doc<"aiConsents"> | null> {
  return await ctx.db.query("aiConsents").withIndex("by_account", (q) => q.eq("account", account)).order("desc").first();
}

export const asAgreement = (row: Doc<"aiConsents"> | null): Agreement | null =>
  row && { answer: row.answer, services: row.services, listVersion: row.listVersion, ...(row.withdrawnAt !== undefined && { withdrawnAt: row.withdrawnAt }) };

const vService = v.object({
  id: v.string(),
  name: v.string(),
  does: v.string(),
  receives: v.array(v.string()),
  policy: v.string(),
  allowed: v.boolean(),
});

export const vStatus = v.object({
  /** False in the single-owner demo: the app shows no permission screen and nothing is blocked. */
  enforced: v.boolean(),
  signedIn: v.boolean(),
  answer: v.union(v.literal("none"), v.literal("allowed"), v.literal("declined"), v.literal("withdrawn")),
  answeredAt: v.optional(v.number()),
  withdrawnAt: v.optional(v.number()),
  needsAnswer: v.boolean(),
  listVersion: v.string(),
  services: v.array(vService),
  alsoUsed: v.array(v.object({ id: v.string(), name: v.string(), does: v.string() })),
});

export const status = query({
  args: {},
  returns: vStatus,
  handler: async (ctx) => {
    const enforced = accessEnforced();
    const account = await currentAccount(ctx);
    const row = account ? await latestAgreement(ctx, account) : null;
    const standing = standingOf(asAgreement(row));
    return {
      enforced,
      signedIn: account !== null,
      answer: standing.answer,
      ...(row && { answeredAt: row.answeredAt }),
      ...(row?.withdrawnAt !== undefined && { withdrawnAt: row.withdrawnAt }),
      needsAnswer: enforced && account !== null && standing.needsAnswer,
      listVersion: LIST_VERSION,
      services: ASKED.map((service) => ({
        id: service.id,
        name: service.name,
        does: service.does,
        receives: service.receives,
        policy: service.policy,
        allowed: standing.allowed.includes(service.id),
      })),
      alsoUsed: ALSO_USED,
    };
  },
});

// The screen sends the list version it showed, so a yes always means the list the owner read.
const answered = async (ctx: Pick<QueryCtx, "db">, account: string, listVersion: string) => {
  if (listVersion !== LIST_VERSION) throw new ConvexError(LIST_CHANGED);
  return await latestAgreement(ctx, account);
};

export const allow = mutation({
  args: { listVersion: v.string() },
  returns: v.null(),
  handler: async (ctx, { listVersion }) => {
    const account = await requireAccount(ctx);
    const row = await answered(ctx, account, listVersion);
    if (row?.answer === "allowed" && row.withdrawnAt === undefined && row.listVersion === LIST_VERSION) return null;
    await ctx.db.insert("aiConsents", {
      account,
      answer: "allowed",
      services: ASKED.map((service) => ({ id: service.id, version: service.version })),
      listVersion,
      answeredAt: Date.now(),
    });
    return null;
  },
});

export const decline = mutation({
  args: { listVersion: v.string() },
  returns: v.null(),
  handler: async (ctx, { listVersion }) => {
    const account = await requireAccount(ctx);
    const row = await answered(ctx, account, listVersion);
    if (row?.answer === "declined" && row.listVersion === LIST_VERSION) return null;
    await ctx.db.insert("aiConsents", { account, answer: "declined", services: [], listVersion, answeredAt: Date.now() });
    return null;
  },
});

/** Takes permission back. Every call the gate answers after this commits is refused. */
export const withdraw = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const account = await requireAccount(ctx);
    const row = await latestAgreement(ctx, account);
    if (row?.answer === "allowed" && row.withdrawnAt === undefined) await ctx.db.patch(row._id, { withdrawnAt: Date.now() });
    return null;
  },
});
