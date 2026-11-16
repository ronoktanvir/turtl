import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalQuery, type ActionCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { openSecret } from "../secrets/open";
import { liveAddressProblem, liveOrigin, requestRefusal } from "./address";
import { DEMO_APP, type TokenRead, type WatchedApp } from "./client";

// The project a request to an owner's app is for, as call() needs it (convex/protectedApp/client.ts).
//
// Single-owner demo (AUTH_REQUIRED unset): DEMO_APP, exactly as before: any address, the deployment's
// PROTECTED_APP_CONTROL_SECRET, nothing read. With accounts on: only the project's live origin, only over https to a
// public name (address.ts), only the project's own control token (convex/secrets), opened in this action when an
// authenticated request is about to leave, and never a redirect followed. The deployment's
// PROTECTED_APP_CONTROL_SECRET is never read.

export type ProjectRef = { appId: string } | { caseId: string };

const vTarget = v.union(v.object({ ok: v.literal(true), appId: v.id("apps"), origin: v.string() }), v.object({ ok: v.literal(false), reason: v.string() }));

// The project's live origin, or why nothing may be sent for it. Fragments: call() writes them into sentences.
export const target = internalQuery({
  args: { appId: v.optional(v.string()), caseId: v.optional(v.string()) },
  returns: vTarget,
  handler: async (ctx, { appId, caseId }) => {
    let appKey = appId === undefined ? null : ctx.db.normalizeId("apps", appId);
    if (caseId !== undefined) {
      const caseKey = ctx.db.normalizeId("cases", caseId);
      appKey = (caseKey ? await ctx.db.get(caseKey) : null)?.appId ?? null;
    }
    const app = appKey ? await ctx.db.get(appKey) : null;
    if (!app) return { ok: false as const, reason: "this project no longer exists, so turtl sent nothing" };
    if (!app.ownerId) return { ok: false as const, reason: "turtl does not know whose project this is, so it sent nothing" };
    if (!app.productionUrl) return { ok: false as const, reason: "this project has no live address, so turtl sent nothing" };
    const origin = liveOrigin(app.productionUrl);
    if (!origin) {
      const problem = liveAddressProblem(app.productionUrl) ?? "The live app address cannot be used.";
      return { ok: false as const, reason: `${problem.charAt(0).toLowerCase()}${problem.slice(1).replace(/\.$/, "")}, so turtl sent nothing` };
    }
    return { ok: true as const, appId: app._id, origin };
  },
});

const TOKEN_WORDS = {
  missing: "no control token is set for this project yet (add it in the project's Settings, under Control token)",
  unreadable: "turtl could not open this project's control token, because the backend's encryption key changed since it was set (enter it again in the project's Settings)",
  no_key: "turtl cannot open stored tokens on this backend, because its encryption key (SECRETS_ENCRYPTION_KEY) is not set",
} as const;

const refusing = (reason: string): WatchedApp => ({
  refuse: () => reason,
  token: async () => ({ ok: false, reason }),
  followRedirects: false,
});

export async function watchedApp(ctx: Pick<ActionCtx, "runQuery">, project: ProjectRef): Promise<WatchedApp> {
  if (!accessEnforced()) return DEMO_APP;
  const found: { ok: true; appId: string; origin: string } | { ok: false; reason: string } = await ctx.runQuery(internal.protectedApp.watched.target, project);
  if (!found.ok) return refusing(found.reason);
  let token: Promise<TokenRead> | null = null;
  const read = async (): Promise<TokenRead> => {
    const opened = await openSecret(ctx, "control_token", { appId: found.appId });
    return opened.ok ? { ok: true, token: opened.value } : { ok: false, reason: TOKEN_WORDS[opened.why] };
  };
  return {
    refuse: (url) => requestRefusal(url, found.origin),
    token: () => (token ??= read()),
    followRedirects: false,
  };
}
