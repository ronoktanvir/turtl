import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, mutation, query } from "../functions";
import { accessEnforced, canSeeApp, guardApp, guardAppInAction } from "../access";
import { liveOrigin } from "../protectedApp/address";
import { watchNotice } from "../protectedApp/watching";
import { seal, sealingKey } from "./seal";
import { clearSlot, contextOf, projectSecret } from "./store";
import { DEMO_KEEPS_CONTROL_TOKEN, NO_SEALING_KEY, NOT_A_CONTROL_TOKEN, sendable } from "./words";

// A project's control token: the bearer token its app's protected routes (journey checks, flags, recovery hooks)
// answer to. With accounts on (AUTH_REQUIRED=true) each project has its own, entered by its owner in the app, and
// turtl sends it only to that project's live address (convex/protectedApp/watched.ts). The single-owner demo keeps
// sending the deployment's PROTECTED_APP_CONTROL_SECRET, so it stores nothing here.

const vStatus = v.object({
  accounts: v.boolean(),
  set: v.boolean(),
  setAt: v.optional(v.number()),
  /** The one origin turtl sends it to: the project's live address. */
  sendsTo: v.optional(v.string()),
  /** Why the monitor is not running this project's checks, or runs only some of them. */
  notWatched: v.optional(v.string()),
});

// Whether the project has a token and when it was set. Never the token.
export const controlToken = query({
  args: { projectId: v.string() },
  returns: v.union(v.null(), vStatus),
  handler: async (ctx, { projectId }) => {
    if (!(await canSeeApp(ctx, projectId))) return null;
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId ? await ctx.db.get(appId) : null;
    if (!app || app.isSample) return null;
    if (!accessEnforced()) return { accounts: false, set: false };
    const row = await projectSecret(ctx, app._id, "control_token");
    const origin = app.productionUrl ? liveOrigin(app.productionUrl) : null;
    const notice = await watchNotice(ctx, app._id);
    return {
      accounts: true,
      set: row !== null,
      ...(row && { setAt: row.setAt }),
      ...(origin && { sendsTo: origin }),
      ...(notice && { notWatched: notice }),
    };
  },
});

// Stores (or replaces) the project's token. Sealing happens here, in an action, which has true randomness.
export const setControlToken = action({
  args: { projectId: v.string(), token: v.string() },
  returns: v.object({ setAt: v.number() }),
  handler: async (ctx, { projectId, token }): Promise<{ setAt: number }> => {
    const account = await guardAppInAction(ctx, projectId);
    if (!accessEnforced()) throw new ConvexError(DEMO_KEEPS_CONTROL_TOKEN);
    const value = token.trim();
    if (!sendable(value)) throw new ConvexError(NOT_A_CONTROL_TOKEN);
    const key = await sealingKey();
    if (!key) throw new ConvexError(NO_SEALING_KEY);
    const box = await seal(value, contextOf("control_token", projectId), key);
    return await ctx.runMutation(internal.secrets.store.put, { kind: "control_token", account, appId: projectId as Id<"apps">, ...box });
  },
});

// Forgets the project's token. Checks that need it stop until a new one is set.
export const removeControlToken = mutation({
  args: { projectId: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    await guardApp(ctx, projectId);
    if (!accessEnforced()) throw new ConvexError(DEMO_KEEPS_CONTROL_TOKEN);
    const appId = ctx.db.normalizeId("apps", projectId);
    if (appId) await clearSlot(ctx, "control_token", { appId });
    return null;
  },
});
