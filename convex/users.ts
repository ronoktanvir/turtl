import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, query } from "./_generated/server";
import { accessEnforced, signedInAccount } from "./access";
import { githubConfigured, resetEmail } from "./auth/settings";

// What the app asks about accounts. `mode` answers before anyone signs in; `viewer` says who is signed in.

const vMethod = v.union(v.literal("password"), v.literal("apple"), v.literal("github"));
const METHODS = ["password", "apple", "github"] as const;
type Method = (typeof METHODS)[number];

/** Whether this backend runs with accounts (AUTH_REQUIRED=true), and which optional parts of sign-in are set up. */
export const mode = query({
  args: {},
  returns: v.object({ accounts: v.boolean(), github: v.boolean(), passwordReset: v.boolean() }),
  handler: async () => ({ accounts: accessEnforced(), github: githubConfigured(), passwordReset: resetEmail() !== null }),
});

/** The signed-in person, or null. Their picture only when it is an https address (GitHub's avatar). */
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      name: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
      picture: v.union(v.string(), v.null()),
      methods: v.array(vMethod),
    }),
  ),
  handler: async (ctx) => {
    const account = await signedInAccount(ctx);
    const userId = account ? ctx.db.normalizeId("users", account) : null;
    const user = userId ? await ctx.db.get(userId) : null;
    if (!userId || !user) return null;
    const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(METHODS.length * 2);
    const methods = METHODS.filter((method) => accounts.some((row) => row.provider === method));
    return {
      id: userId,
      name: user.name?.trim() || null,
      email: user.email ?? null,
      picture: user.image?.startsWith("https://") ? user.image : null,
      methods: methods as Method[],
    };
  },
});

/** The account this caller's records are filed under, through the same check every action uses. Refuses when
 * accounts are on and nobody is signed in. */
export const account = action({
  args: {},
  returns: v.string(),
  handler: async (ctx): Promise<string> => await ctx.runQuery(internal.access.account, {}),
});
