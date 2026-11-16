import { query } from "../_generated/server";
import { v } from "convex/values";
import { accessEnforced, canSeeApp, projectCases, visibleApps } from "../access";
import { currentPermission, MIN_VERIFIED_RECOVERIES, sourceAction, usesOf } from "../permissions";
import { latestForCase, toPullRequest } from "../prTracking/records";

export const list = query({
  args: {},
  handler: async (ctx) => {
    // Accounts: the caller's projects by the by_owner index and each one's newest cases by the by_app index, oldest
    // first like the demo's read. The demo still reads every app and every case.
    const accounts = accessEnforced();
    const apps = (accounts ? await visibleApps(ctx) : await ctx.db.query("apps").collect()).filter((app) => !app.isSample);
    const cases = accounts
      ? (await Promise.all(apps.map(async (app) => (await projectCases(ctx, app._id)).reverse()))).flat().filter((row) => !row.isSample)
      : (await ctx.db.query("cases").collect()).filter((row) => !row.isSample);
    const projects = [];
    for (const app of apps) {
      const journeys = await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", app._id)).collect();
      if (!journeys.length && !app.repoUrl && !app.productionUrl) continue;
      const permissions = await ctx.db.query("permissions").withIndex("by_app", (q) => q.eq("appId", app._id)).collect();
      const active = [];
      for (const permission of permissions) {
        if (permission.revokedAt !== undefined || (permission.expiresAt !== undefined && permission.expiresAt <= Date.now())) continue;
        if ((await usesOf(ctx, permission._id)).length >= permission.maxAttempts) continue;
        active.push(permission);
      }
      projects.push({
        app,
        approvals: active.length ? "auto" as const : "you" as const,
        cases: await Promise.all(cases.filter((row) => row.appId === app._id).map(async (row) => {
          const pullRequest = await latestForCase(ctx, row._id);
          return { ...row, pullRequest: pullRequest ? toPullRequest(pullRequest) : null };
        })),
      });
    }
    return projects;
  },
});

export const approvalSettings = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    if (!(await canSeeApp(ctx, projectId))) return null;
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId ? await ctx.db.get(appId) : null;
    if (!app || app.isSample) return null;
    const memories = (await ctx.db.query("recoveryMemories").collect()).filter((memory) => memory.appId === app._id && memory.invalidatedAt === undefined);
    const candidates = [];
    const active = [];
    for (const memory of memories) {
      const permission = await currentPermission(ctx, memory, Date.now());
      const source = await sourceAction(ctx, memory);
      if (permission) active.push({ permission, memory, source });
      if (memory.timesVerified >= MIN_VERIFIED_RECOVERIES && memory.appRevision && source) candidates.push({ memory, source });
    }
    const scopes = (active.length ? active : candidates.slice(0, 1)).map((chosen) => {
      const target = chosen.source?.executionPayload.target;
      const values = chosen.source?.executionPayload.parameters.map((p) => `${p.name}=${JSON.stringify(p.value)}`).join(", ");
      return `turtl may ${chosen.memory.actionType.replace(/_/g, " ")} on ${target?.resourceRef ?? "the recorded target"} (${target?.environment ?? "the recorded environment"}) with ${values || "no values"}, at most 3 times, and only while the app runs version ${chosen.memory.appRevision}. Before each run it checks again that the conditions still hold.`;
    });
    return {
      active: active.length > 0,
      permissionIds: active.map((entry) => entry.permission._id),
      memoryId: candidates.length === 1 ? candidates[0].memory._id : null,
      canEnable: !active.length && candidates.length === 1,
      scope: scopes.length ? scopes.join("\n") : undefined,
      reason: active.length > 1 ? `${active.length} separate bounded recovery permissions are active. Other fixes still need your approval.`
        : active.length ? "Only the recorded recovery is permitted. Other fixes still need your approval."
        : candidates.length > 1 ? "Several recoveries qualify. Grant a specific recovery from its live case so this switch cannot choose for you."
        : candidates.length === 1 ? "This recovery has two verified recoveries and can receive one bounded permission."
        : "Auto needs two verified recoveries of the same action, a recorded app version, and its original action. No recovery qualifies yet.",
    };
  },
});
