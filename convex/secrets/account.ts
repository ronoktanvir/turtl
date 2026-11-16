import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, mutation, query } from "../_generated/server";
import { accessEnforced, currentAccount, requireAccount } from "../access";
import { seal, sealingKey } from "./seal";
import { accountSecret, clearSlot, contextOf } from "./store";
import { DEMO_KEEPS_CODING_AGENT, NO_SEALING_KEY, NOT_A_CODING_AGENT_KEY, sendable } from "./words";

// An account's coding agent: its own Capy API key. With accounts on (AUTH_REQUIRED=true) every coding-agent thread
// for the account's projects (code changes and the onboarding preparation) starts with this key and never with the
// deployment's CAPY_API_KEY (convex/prTracking/capy.ts). The single-owner demo keeps using CAPY_API_KEY.

const vStatus = v.object({ accounts: v.boolean(), signedIn: v.boolean(), set: v.boolean(), setAt: v.optional(v.number()) });

// Whether the account has connected its coding agent, and when. Never the key.
export const codingAgent = query({
  args: {},
  returns: vStatus,
  handler: async (ctx) => {
    if (!accessEnforced()) return { accounts: false, signedIn: true, set: false };
    const account = await currentAccount(ctx);
    if (!account) return { accounts: true, signedIn: false, set: false };
    const row = await accountSecret(ctx, account, "coding_agent_key");
    return { accounts: true, signedIn: true, set: row !== null, ...(row && { setAt: row.setAt }) };
  },
});

export const setCodingAgentKey = action({
  args: { apiKey: v.string() },
  returns: v.object({ setAt: v.number() }),
  handler: async (ctx, { apiKey }): Promise<{ setAt: number }> => {
    const account: string = await ctx.runQuery(internal.access.account, {});
    if (!accessEnforced()) throw new ConvexError(DEMO_KEEPS_CODING_AGENT);
    const value = apiKey.trim();
    if (!sendable(value)) throw new ConvexError(NOT_A_CODING_AGENT_KEY);
    const key = await sealingKey();
    if (!key) throw new ConvexError(NO_SEALING_KEY);
    const box = await seal(value, contextOf("coding_agent_key", account), key);
    return await ctx.runMutation(internal.secrets.store.put, { kind: "coding_agent_key", account, ...box });
  },
});

// Disconnects the coding agent. Threads already started keep running at Capy; turtl starts no new one.
export const removeCodingAgentKey = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const account = await requireAccount(ctx);
    if (!accessEnforced()) throw new ConvexError(DEMO_KEEPS_CODING_AGENT);
    await clearSlot(ctx, "coding_agent_key", { account });
    return null;
  },
});
