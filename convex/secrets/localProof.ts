import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { localBackend } from "../demoSettings";

declare const process: { env: Record<string, string | undefined> };

// Seeds and reads for tests/project-secrets-local.integration.mjs, which proves per-project tokens, safe addresses, the
// monitor and the owner's own coding agent on a real local Convex backend, against stand-ins on this machine. Internal,
// and refused anywhere but a localhost backend with the dev tools switched on.

function requireLocalProof() {
  if (process.env.DEV_TOOLS_ENABLED !== "true" || !localBackend()) {
    throw new Error("Secrets proofs require a localhost backend with the dev tools enabled.");
  }
}

const vOwner = v.object({ email: v.string(), repo: v.string(), liveUrl: v.string(), connected: v.boolean() });

// Two owners, each with a project on its own origin: a journey that needs the control token, onboarding rows ready for
// approval, and for an owner marked connected, a GitHub installation linked to them (whose id it returns, so the proof can
// cache a token for it and turtl reaches the repository without asking GitHub). `extra` adds journeys at other addresses.
export const seed = internalMutation({
  args: { owners: v.array(vOwner), extra: v.array(v.object({ owner: v.number(), name: v.string(), url: v.string() })), run: v.number() },
  returns: v.array(v.object({ account: v.string(), appId: v.id("apps"), inspectionId: v.id("onboardingInspections"), preparationId: v.id("onboardingPreparations"), installationId: v.optional(v.number()) })),
  handler: async (ctx, { owners, extra, run }) => {
    requireLocalProof();
    const now = Date.now();
    const seeded = [];
    for (const [index, owner] of owners.entries()) {
      const account = await ctx.db.insert("users", { email: owner.email });
      // The sign-in method a sign-up makes, so each owner is an account as the rest of turtl counts them.
      await ctx.db.insert("authAccounts", { userId: account, provider: "password", providerAccountId: `${run}-${owner.email}` });
      const appId = await ctx.db.insert("apps", { name: owner.repo, ownerId: account, repoUrl: `https://github.com/${owner.repo}`, productionUrl: owner.liveUrl });
      await ctx.db.insert("journeys", {
        appId, name: "Book an appointment", description: "A stand-in journey.", checkVersion: "proof-v1",
        check: { kind: "http", config: { url: `${owner.liveUrl}/journey-check`, method: "POST", expectedStatus: 200, credentialRef: "PROTECTED_APP_CONTROL_SECRET" } },
      });
      const inspectionId = await ctx.db.insert("onboardingInspections", {
        appId, repo: owner.repo, folders: [], status: "done", ref: "abc123", defaultBranch: "main", startedAt: now, finishedAt: now, hasManifest: false,
        stack: { id: "expo-convex", label: "Expo with a Convex backend", supported: true, evidence: [] },
        items: [{ key: "health_check", status: "missing", note: "No health check.", files: [] }], suggestions: [],
      });
      const preparationId = await ctx.db.insert("onboardingPreparations", {
        appId, answeredAt: now, neverBreak: [{ id: "owner-1", text: "Customers can book and get a confirmation.", suggested: false, addCheck: true }],
      });
      if (owner.connected) {
        const installationId = 900_000_000 + run * 10 + index;
        const attemptId = await ctx.db.insert("githubConnectAttempts", { account, stateHash: `proof-${run}-${index}`, codeVerifier: "proof", returnTo: "app", status: "finished", expiresAt: now });
        await ctx.db.insert("githubInstallations", { installationId, accountLogin: owner.repo.split("/")[0], repositorySelection: "selected", status: "active", updatedAt: now });
        await ctx.db.insert("githubInstallationRepositories", { installationId, fullName: owner.repo, fullNameLower: owner.repo.toLowerCase(), seenAt: now });
        await ctx.db.insert("githubInstallationLinks", { account, installationId, attemptId, active: true, githubUserId: 1 + index, githubLogin: owner.repo.split("/")[0], confirmedAt: now });
      }
      // The proof caches the installation's token through github/tokens:store, the only writer of that table.
      seeded.push({ account: account as string, appId, inspectionId, preparationId, ...(owner.connected && { installationId: 900_000_000 + run * 10 + index }) });
    }
    for (const journey of extra) {
      await ctx.db.insert("journeys", {
        appId: seeded[journey.owner].appId, name: journey.name, description: "A stand-in journey.", checkVersion: "proof-v1",
        check: { kind: "http", config: { url: journey.url, method: "POST", expectedStatus: 200, credentialRef: "PROTECTED_APP_CONTROL_SECRET" } },
      });
    }
    return seeded;
  },
});

// Marks a preparation's pull request merged, as GitHub would, so registration and Check again can run.
export const markMerged = internalMutation({
  args: { preparationId: v.id("onboardingPreparations"), sha: v.string() },
  returns: v.null(),
  handler: async (ctx, { preparationId, sha }) => {
    requireLocalProof();
    const now = Date.now();
    await ctx.db.patch(preparationId, { mergedAt: now, settledAt: now, mergeCommitSha: sha, registration: { status: "done", checks: [], ref: sha } });
    return null;
  },
});

// What the proof checks after the backend has run: the preparations, the monitor's notes, the journeys' last passes, and
// how many secrets are stored (never what they hold).
export const snapshot = internalQuery({
  args: { appIds: v.array(v.id("apps")) },
  returns: v.any(),
  handler: async (ctx, { appIds }) => {
    requireLocalProof();
    const projects = [];
    for (const appId of appIds as Id<"apps">[]) {
      projects.push({
        appId,
        preparation: await ctx.db.query("onboardingPreparations").withIndex("by_app", (q) => q.eq("appId", appId)).first(),
        watched: await ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).first(),
        journeys: (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).take(100)).map((journey) => ({ name: journey.name, lastPassedAt: journey.lastPassedAt ?? null })),
        secrets: (await ctx.db.query("secrets").withIndex("by_app_and_kind", (q) => q.eq("appId", appId)).take(10)).length,
      });
    }
    return projects;
  },
});
