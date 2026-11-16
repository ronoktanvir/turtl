import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { localBackend } from "../demoSettings";

declare const process: { env: Record<string, string | undefined> };

// Seeds and reads for tests/not-answering-local.integration.mjs, which proves cases for an app that stops answering
// (convex/protectedApp/notAnswering.ts) on a real local Convex backend, against a stand-in app on this machine.
// Internal, and refused anywhere but a localhost backend with the dev tools switched on.

function requireLocalProof() {
  if (process.env.DEV_TOOLS_ENABLED !== "true" || !localBackend()) {
    throw new Error("Not-answering proofs require a localhost backend with the dev tools enabled.");
  }
}

// One owner with a live sign-in session (so their phone can be registered for notifications) and one project on the
// stand-in's address, with `checks` checks that need no control token.
export const seed = internalMutation({
  args: { email: v.string(), liveUrl: v.string(), checks: v.number(), run: v.string() },
  returns: v.object({ account: v.id("users"), sessionId: v.id("authSessions"), appId: v.id("apps") }),
  handler: async (ctx, { email, liveUrl, checks, run }) => {
    requireLocalProof();
    const account = await ctx.db.insert("users", { email });
    await ctx.db.insert("authAccounts", { userId: account, provider: "password", providerAccountId: `${run}-${email}` });
    const sessionId = await ctx.db.insert("authSessions", { userId: account, expirationTime: Date.now() + 2 * 60 * 60_000 });
    const appId = await ctx.db.insert("apps", { name: "Proof shop", ownerId: account, repoUrl: "https://github.com/proof/shop", productionUrl: liveUrl });
    for (let n = 0; n < checks; n++) {
      await ctx.db.insert("journeys", {
        appId, name: `Book ${n + 1}`, description: "A stand-in journey.", checkVersion: "proof-v1",
        check: { kind: "http", config: { url: `${liveUrl}/check-${n + 1}/journey-check`, method: "POST", expectedStatus: 200 } },
      });
    }
    return { account, sessionId, appId };
  },
});

// What the proof checks after the backend has run: the project's checks and their counts, the monitor's row, and its
// newest cases with their steps, owner notices and push sends.
export const snapshot = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.any(),
  handler: async (ctx, { appId }) => {
    requireLocalProof();
    const cases = await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", appId)).order("desc").take(10);
    return {
      watched: await ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).first(),
      journeys: (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).take(25)).map((journey) => ({
        name: journey.name,
        lastPassedAt: journey.lastPassedAt ?? null,
        unanswered: journey.unanswered ?? null,
      })),
      cases: await Promise.all(
        cases.map(async (row) => ({
          ...row,
          steps: await ctx.db.query("steps").withIndex("by_case", (q) => q.eq("caseId", row._id)).take(10),
          attempts: await ctx.db.query("stepAttempts").withIndex("by_case", (q) => q.eq("caseId", row._id)).take(10),
          notices: await ctx.db.query("ownerNotices").withIndex("by_case_and_event", (q) => q.eq("caseId", row._id)).take(10),
          pushes: await ctx.db.query("pushSends").withIndex("by_case", (q) => q.eq("caseId", row._id)).take(10),
        })),
      ),
    };
  },
});
