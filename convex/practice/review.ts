import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { accessEnforced } from "../access";
import { findPasswordAccount } from "../auth/password";
import { normalizeEmail, words } from "../auth/rules";
import { ensurePractice } from "./projects";

// The App Review account's practice project with a case open (checklist RC-02, store/review-notes.txt). The operator
// makes the review account first, with auth/review:ensureAccount, which also marks its address confirmed (the review
// address may not be a real mailbox, and an unconfirmed account sees only Check your email), then runs this once:
//   npx convex run auth/review:ensureAccount '{"email":"review@example.com","password":"..."}'
//   npx convex run practice/review:prepare '{"email":"review@example.com"}'
// An account made by signing up in the app works too once its address is confirmed; this refuses one that is not.
// It makes the account's practice project if it has none, and unless a case is already open on it, breaks it the way
// the review notes describe (recommendations time out) and runs the monitor's check of it at once, which opens the case.
// The case then runs as every case does, through to waiting for the reviewer's approval. This break does not count
// against the account's own daily allowance. Running it again while a case is open changes nothing.

type Opened = { caseId: Id<"cases">; status: string } | null;

export const prepare = internalAction({
  args: { email: v.string() },
  returns: v.object({ projectId: v.id("apps"), caseId: v.id("cases"), created: v.boolean() }),
  handler: async (ctx, args): Promise<{ projectId: Id<"apps">; caseId: Id<"cases">; created: boolean }> => {
    if (!accessEnforced()) throw new ConvexError("Run this on a backend with accounts on (AUTH_REQUIRED=true). The single-owner demo has no review account.");
    const email = normalizeEmail(args.email);
    if (!email) throw new ConvexError(words.badEmail);
    const login = await findPasswordAccount(ctx, email);
    if (!login) throw new ConvexError("No email-and-password account uses that address. Make the review account first with auth/review:ensureAccount, then run this again.");
    const account = login.userId as string;
    const confirmed: boolean = await ctx.runQuery(internal.auth.confirmation.isConfirmed, { account });
    if (!confirmed) throw new ConvexError("That account has not confirmed its email address, so the reviewer would see only Check your email. Run auth/review:ensureAccount for it (or auth/confirmation:markConfirmed), then run this again.");
    const projectId = await ensurePractice(ctx, account);
    const open: Opened = await ctx.runQuery(internal.practice.projects.openCaseOf, { appId: projectId });
    if (open) return { projectId, caseId: open.caseId, created: false };

    // A practice app left broken by an earlier case (declined, or unresolved) opens no new case until the monitor has
    // seen it pass, so it is put back and checked first.
    const state: { failure: string | null } | null = await ctx.runQuery(internal.practice.projects.practiceState, { appId: projectId });
    if (state?.failure) {
      await ctx.runMutation(internal.practice.projects.operatorMend, { appId: projectId });
      await ctx.runAction(internal.monitor.checkProject, { appId: projectId });
    }
    await ctx.runMutation(internal.practice.projects.operatorBreak, { appId: projectId, failure: "recommendations" });
    await ctx.runAction(internal.monitor.checkProject, { appId: projectId });
    const opened: Opened = await ctx.runQuery(internal.practice.projects.openCaseOf, { appId: projectId });
    if (!opened) throw new ConvexError("The practice app is broken, but the monitor's check opened no case. Read the monitor's note on the project (Settings, Control token) and run this again.");
    return { projectId, caseId: opened.caseId, created: true };
  },
});
