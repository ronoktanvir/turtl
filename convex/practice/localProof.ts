import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { localBackend } from "../demoSettings";

declare const process: { env: Record<string, string | undefined> };

// Reads for scripts/practice/prove-local.mjs, which proves practice projects on a real local Convex backend with accounts
// on. Internal, read-only, and refused anywhere but a localhost backend with the dev tools switched on. It counts and
// summarises; it never reads a token (the secrets module's own localProof counts those).

function requireLocalProof() {
  if (process.env.DEV_TOOLS_ENABLED !== "true" || !localBackend()) {
    throw new Error("Practice proofs require a localhost backend with the dev tools enabled.");
  }
}

export const snapshot = internalQuery({
  args: { appIds: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, { appIds }) => {
    requireLocalProof();
    const projects = [];
    for (const raw of appIds) {
      const appId = ctx.db.normalizeId("apps", raw) as Id<"apps"> | null;
      const app = appId ? await ctx.db.get(appId) : null;
      const practice = appId ? await ctx.db.query("practiceApps").withIndex("by_app", (q) => q.eq("appId", appId)).first() : null;
      const bookings = appId ? (await ctx.db.query("practiceBookings").withIndex("by_app_and_fixture", (q) => q.eq("appId", appId)).take(100)).length : 0;
      const journeys = appId ? await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", appId)).take(10) : [];
      const catalog = appId ? await ctx.db.query("actionCatalog").withIndex("by_app_and_type", (q) => q.eq("appId", appId)).take(10) : [];
      const cases = appId ? await ctx.db.query("cases").withIndex("by_app", (q) => q.eq("appId", appId)).take(50) : [];
      const watched = appId ? await ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).first() : null;
      projects.push({
        appId: raw,
        app: app && { name: app.name, practice: app.practice ?? false, repoUrl: app.repoUrl ?? null, productionUrl: app.productionUrl ?? null },
        practice: practice && {
          recommendationsEnabled: practice.recommendationsEnabled,
          providerTimeout: practice.providerTimeout,
          bookingStoreFailure: practice.bookingStoreFailure,
          backupStoreEnabled: practice.backupStoreEnabled,
          broken: practice.broken ?? null,
          breaks: practice.breaks ?? null,
          tokenHashLength: practice.tokenHash.length,
        },
        bookings,
        journeys: journeys.map((journey) => ({ name: journey.name, lastPassedAt: journey.lastPassedAt ?? null })),
        catalog: catalog.map((entry) => ({ name: entry.name, kind: entry.config.kind })),
        cases: cases.map((row) => ({ id: row._id, title: row.title, status: row.status, raisedBy: row.raisedBy })),
        watched: watched && { notice: watched.notice?.reason ?? null, lastCheckedAt: watched.lastCheckedAt ?? null },
      });
    }
    return projects;
  },
});
