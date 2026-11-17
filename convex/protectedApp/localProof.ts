import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { localBackend } from "../demoSettings";

declare const process: { env: Record<string, string | undefined> };

// Seeds and reads for tests/not-answering-local.integration.mjs, which proves cases for an app that stops answering
// (convex/protectedApp/notAnswering.ts), and for tests/watched-checks-local.integration.mjs, which proves health and
// readiness checks and the retiring of a check, each on a real local Convex backend against a stand-in app on this
// machine. Internal, and refused anywhere but a localhost backend with the dev tools switched on.

function requireLocalProof() {
  if (process.env.DEV_TOOLS_ENABLED !== "true" || !localBackend()) {
    throw new Error("Not-answering proofs require a localhost backend with the dev tools enabled.");
  }
}

// One owner with a live sign-in session (so their phone can be registered for notifications) and one project on the
// stand-in's address, with `checks` checks that need no control token. `health`: also its health endpoint, registered
// as a journey exactly as onboarding registers one (convex/onboarding/prepare.ts, checkLive): a GET check that says it
// is the health probe, passed at registration from its 200. `repo`: the project was prepared through onboarding and its
// preparation merged at `mergeCommit`, so the real registration can read its turtl.json from a stand-in for GitHub.
export const seed = internalMutation({
  args: { email: v.string(), liveUrl: v.string(), checks: v.number(), run: v.string(), health: v.optional(v.boolean()), repo: v.optional(v.string()), mergeCommit: v.optional(v.string()) },
  returns: v.object({ account: v.id("users"), sessionId: v.id("authSessions"), appId: v.id("apps"), preparationId: v.optional(v.id("onboardingPreparations")) }),
  handler: async (ctx, { email, liveUrl, checks, run, health, repo, mergeCommit }) => {
    requireLocalProof();
    const account = await ctx.db.insert("users", { email });
    await ctx.db.insert("authAccounts", { userId: account, provider: "password", providerAccountId: `${run}-${email}` });
    const sessionId = await ctx.db.insert("authSessions", { userId: account, expirationTime: Date.now() + 2 * 60 * 60_000 });
    const appId = await ctx.db.insert("apps", { name: "Proof shop", ownerId: account, repoUrl: `https://github.com/${repo ?? "proof/shop"}`, productionUrl: liveUrl });
    for (let n = 0; n < checks; n++) {
      await ctx.db.insert("journeys", {
        appId, name: `Book ${n + 1}`, description: "A stand-in journey.", checkVersion: "proof-v1",
        check: { kind: "http", config: { url: `${liveUrl}/check-${n + 1}/journey-check`, method: "POST", expectedStatus: 200 } },
      });
    }
    if (health) {
      await ctx.db.insert("journeys", {
        appId, name: "Health", description: "The server answers its health check.", checkVersion: `onboarding-manifest-v1:${run}`,
        check: { kind: "http", config: { url: `${liveUrl}/health`, method: "GET", expectedStatus: 200 } },
        probe: "health",
        lastPassedAt: Date.now(),
      });
    }
    const now = Date.now();
    const preparationId = repo && mergeCommit
      ? await ctx.db.insert("onboardingPreparations", { appId, neverBreak: [], repo, baseBranch: "main", approvedAt: now, mergedAt: now, settledAt: now, mergeCommitSha: mergeCommit, nextSyncAt: Number.MAX_SAFE_INTEGER })
      : undefined;
    return { account, sessionId, appId, ...(preparationId && { preparationId }) };
  },
});

// What the proof checks after the backend has run: every check row of the project (retired ones too) and its counts,
// the monitor's row, what the last registration recorded, and its newest cases with their steps, owner notices and
// push sends.
export const snapshot = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.any(),
  handler: async (ctx, { appId }) => {
    requireLocalProof();
    const cases = await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", appId)).order("desc").take(10);
    return {
      watched: await ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).first(),
      journeys: (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).take(60)).map((journey) => ({
        id: journey._id,
        name: journey.name,
        method: journey.check.kind === "http" ? journey.check.config.method : null,
        probe: journey.probe ?? null,
        checkVersion: journey.checkVersion,
        retiredAt: journey.retiredAt ?? null,
        lastPassedAt: journey.lastPassedAt ?? null,
        unanswered: journey.unanswered ?? null,
      })),
      registration: (await ctx.db.query("onboardingPreparations").withIndex("by_app", (q) => q.eq("appId", appId)).first())?.registration ?? null,
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
