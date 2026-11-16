import { NO_SUPERMEMORY } from "../constants";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, type ActionCtx } from "../_generated/server";
import { openKept, revokeToken, type KeptToken } from "../auth/appleTokens";
import { appleClient } from "../auth/settings";
import { gateFor } from "../consent/gate";
import { plainFailure } from "../consent/outbound";
import { sealingKey } from "../secrets/seal";
import { deleteNamespace } from "../supermemory";
import type { VendorTask } from "./schema";

declare const process: { env: Record<string, string | undefined> };

// The deletions turtl asks of other services when an account is deleted. Each answers ok (done, or nothing to
// delete) or a plain reason, never the vendor's own text. A failure is retried by the job (deletion.ts) and never
// stops the rest of the deletion.
//
// - Supermemory: each namespace the account's projects wrote to is deleted whole (DELETE /ns/<namespace>). It sends
//   only the name, so it goes through the AI permission gate as an "erase", which needs no permission.
// - GitHub: internal.github.connect.disconnectAccount uninstalls turtl's GitHub App from every installation on the
//   person's own GitHub account that only this account uses, and removes turtl's records of it. From an
//   organization's installation (or anyone else's) it removes only this account's link and the cached token.
// - Apple: each Sign in with Apple refresh token kept for the account is revoked (convex/auth/appleTokens.ts).

export type Outcome = { ok: true; skipped?: boolean; note?: string } | { ok: false; note: string };

export async function runVendorTask(ctx: ActionCtx, account: string, task: Pick<VendorTask, "service" | "target">): Promise<Outcome> {
  if (task.service === "supermemory") return await eraseNamespace(ctx, account, task.target ?? "");
  if (task.service === "github") return await disconnectGithub(ctx, account);
  return await revokeApple(ctx, account);
}

async function eraseNamespace(ctx: ActionCtx, account: string, namespace: string): Promise<Outcome> {
  if (!namespace) return { ok: true, skipped: true, note: "No namespace was named." };
  // Without a key turtl never wrote to Supermemory, and cannot reach it to delete.
  if (!process.env.SUPERMEMORY_API_KEY) return { ok: true, skipped: true, note: `${NO_SUPERMEMORY}, so turtl kept nothing there.` };
  try {
    const deleted = await deleteNamespace(gateFor(ctx, { account }), namespace);
    return { ok: true, note: deleted ? "Deleted at Supermemory." : "Supermemory had nothing under this name." };
  } catch (error) {
    return { ok: false, note: plainFailure("Supermemory", error) };
  }
}

async function disconnectGithub(ctx: ActionCtx, account: string): Promise<Outcome> {
  const installationIds: number[] = await ctx.runQuery(internal.github.links.installationsOf, { account });
  const result: { ok: boolean; disconnected: number; failed: { installationId: number; message: string }[]; stillInstalled?: unknown[] } = await ctx.runAction(
    internal.github.connect.disconnectAccount,
    { account },
  );
  if (!result.ok) return { ok: false, note: [...new Set(result.failed.map((failure) => failure.message))].join(" ") || "GitHub did not confirm." };
  if (installationIds.length) await ctx.runMutation(internal.account.vendors.forgetInstallationNames, { installationIds });
  // An organization's installation, or one someone else uses, is not this account's to remove: its link is gone, and
  // the app stays installed there. The note names no account, so the deletion record holds nothing personal.
  const kept = result.stillInstalled?.length ?? 0;
  const ended = installationIds.length ? `turtl's access ended for ${installationIds.length} GitHub installation(s).` : "turtl had no access to GitHub for this account.";
  return { ok: true, note: kept ? `${ended} ${kept} of them stay installed on GitHub until their owners remove turtl there.` : ended };
}

async function revokeApple(ctx: ActionCtx, account: string): Promise<Outcome> {
  const tokens: KeptToken[] = await ctx.runQuery(internal.auth.appleTokens.tokensOf, { account });
  if (!tokens.length) return { ok: true, skipped: true, note: "No Sign in with Apple token was kept for this account." };
  const client = appleClient();
  if (!client) return { ok: false, note: "AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID and AUTH_APPLE_PRIVATE_KEY are not all set, so turtl cannot revoke the Apple token yet." };
  const key = await sealingKey();
  for (const token of tokens) {
    // Opened here, in the action that sends it to Apple, and nowhere else.
    const opened = await openKept(token, account, key);
    if (!opened.ok) return { ok: false, note: `${opened.reason}.` };
    const revoked = await revokeToken(client, opened.refreshToken);
    if (!revoked.ok) return { ok: false, note: `${revoked.reason}.` };
    await ctx.runMutation(internal.auth.appleTokens.forget, { id: token.id });
  }
  return { ok: true, note: `Apple revoked ${tokens.length} token(s).` };
}

/** After turtl's app was uninstalled from an installation nobody else uses, its row stays (marked deleted, so a
 * replayed webhook cannot bring it back) without the GitHub login it was on. */
export const forgetInstallationNames = internalMutation({
  args: { installationIds: v.array(v.number()) },
  returns: v.null(),
  handler: async (ctx, { installationIds }) => {
    for (const installationId of installationIds.slice(0, 100)) {
      const row = await ctx.db.query("githubInstallations").withIndex("by_installation", (q) => q.eq("installationId", installationId)).unique();
      if (row?.status !== "deleted") continue;
      const linked = await ctx.db.query("githubInstallationLinks").withIndex("by_installation", (q) => q.eq("installationId", installationId)).first();
      if (!linked && row.accountLogin) await ctx.db.patch(row._id, { accountLogin: "" });
    }
    return null;
  },
});
