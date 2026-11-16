import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { accessEnforced, requireAccount } from "./access";

// The single-owner demo's shared owner passcode. With accounts on (AUTH_REQUIRED=true, convex/access.ts) the account
// replaces it: an owner decision is authorised by being the signed-in owner of the project, which the decision
// checks itself, and no passcode is asked for, accepted, or set.

export const PASSCODE_REPLACED = "This deployment protects owner decisions with your account, so there is no owner passcode to set.";

async function digest(passcode: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passcode)));
}

async function verify(passcode: string | undefined, expected: string) {
  const actual = await digest(passcode ?? "");
  let difference = 0;
  for (let index = 0; index < 32; index++) {
    difference |= actual[index] ^ parseInt(expected.slice(index * 2, index * 2 + 2), 16);
  }
  if (difference !== 0 || passcode === undefined) {
    throw new ConvexError("That owner passcode is incorrect. Try again.");
  }
}

export async function requireOwnerPasscode(ctx: QueryCtx, passcode?: string, requireConfigured = false) {
  // Accounts: the caller has checked that the project is theirs. A passcode sent anyway is ignored; it never stands in for the account.
  if (accessEnforced()) {
    await requireAccount(ctx);
    return null;
  }
  const config = await ctx.db.query("ownerPasscodeConfig").unique();
  if (!config) {
    if (requireConfigured) {
      throw new ConvexError("Set an owner passcode in project settings before linking or merging a pull request.");
    }
    return null;
  }
  await verify(passcode, config.passcodeDigest);
  return null;
}

// accounts is present only with accounts on: the client then runs owner decisions without a prompt and hides the passcode settings.
export const status = query({
  args: {},
  returns: v.object({ configured: v.boolean(), accounts: v.optional(v.literal(true)) }),
  handler: async (ctx) =>
    accessEnforced()
      ? { configured: false, accounts: true as const }
      : { configured: (await ctx.db.query("ownerPasscodeConfig").unique()) !== null },
});

export const set = mutation({
  args: { passcode: v.string(), currentPasscode: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { passcode, currentPasscode }) => {
    if (accessEnforced()) throw new ConvexError(PASSCODE_REPLACED);
    const config = await ctx.db.query("ownerPasscodeConfig").unique();
    if (config) await verify(currentPasscode, config.passcodeDigest);
    if (passcode.length < 8 || passcode.length > 256) {
      throw new ConvexError("Use an owner passcode between 8 and 256 characters.");
    }
    const passcodeDigest = Array.from(await digest(passcode), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (config) {
      await ctx.db.patch(config._id, { passcodeDigest });
    } else {
      await ctx.db.insert("ownerPasscodeConfig", { passcodeDigest });
    }
    return null;
  },
});

export const authorize = internalQuery({
  args: { passcode: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { passcode }) => await requireOwnerPasscode(ctx, passcode, true),
});

export const clear = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const config of await ctx.db.query("ownerPasscodeConfig").collect()) {
      await ctx.db.delete(config._id);
    }
    return null;
  },
});
