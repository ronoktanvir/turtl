import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx } from "../_generated/server";
import { query } from "../functions";
import { accessEnforced, visibleApp, visibleApps } from "../access";
import { CLOSED_CASE_STATUSES } from "../constants";
import { latestInspection, preparationFor } from "../onboarding/records";
import { stageOf } from "../onboarding/stage";

// What turtl is watching on one project before anything has gone wrong: its registered checks and when each
// last passed, whether the preparation is still under way, and how much of its code is mapped. Read-only.

/** More checks than one project registers; it bounds the read. */
const MAX_CHECKS = 50;
/** How many recent code networks to look through when none is filed under this project's id. */
const MAX_NETWORKS = 100;
/** A case stops counting as open once it is closed or its service is restored (as in convex/monitor.ts). */
const NOT_OPEN: readonly string[] = [...CLOSED_CASE_STATUSES, "restored"];

const vCheckState = v.union(v.literal("passing"), v.literal("failing"), v.literal("waiting"));
const vWatchedCheck = v.object({
  id: v.string(),
  kind: v.union(v.literal("journey"), v.literal("health"), v.literal("readiness"), v.literal("flag")),
  name: v.string(),
  state: vCheckState,
  lastPassedAt: v.optional(v.number()),
});
export const vOverview = v.object({
  checks: v.array(vWatchedCheck),
  // unreadable: turtl could not read the repository, so nothing is being prepared until the owner tries again.
  preparation: v.union(v.literal("none"), v.literal("in_progress"), v.literal("done"), v.literal("unreadable")),
  map: v.union(v.null(), v.object({ parts: v.number(), groups: v.number() })),
});

function repository(value: string | undefined): string | null {
  const match = value?.trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+)\/?$/i);
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}`.toLowerCase() : null;
}

/** The same network the Investigate screen opens (convex/screens/network.ts), read with a bound. */
async function codeMap(ctx: QueryCtx, app: Doc<"apps">) {
  const repo = repository(app.repoUrl);
  if (!repo) return null;
  const direct = await ctx.db.query("codeNetworks").withIndex("by_project", (q) => q.eq("projectId", app._id)).order("desc").first();
  if (direct && repository(direct.repo) === repo) return mapOf(direct);
  // Another project's map of the same repository may stand in, but with accounts on only one of the caller's own:
  // a project that merely names someone else's repository must not learn the size of their map.
  const others = accessEnforced()
    ? (await Promise.all((await visibleApps(ctx)).map((owned) =>
        ctx.db.query("codeNetworks").withIndex("by_project", (q) => q.eq("projectId", owned._id)).order("desc").first(),
      ))).flatMap((row) => (row ? [row] : [])).sort((a, b) => b._creationTime - a._creationTime)
    : await ctx.db.query("codeNetworks").order("desc").take(MAX_NETWORKS);
  return mapOf(others.find((row) => repository(row.repo) === repo));
}

const mapOf = (network: Doc<"codeNetworks"> | null | undefined) =>
  network && network.nodes.length ? { parts: network.nodes.length, groups: network.clusters.length } : null;

async function journeyFailing(ctx: QueryCtx, appId: Id<"apps">, journeyId: Id<"journeys">) {
  const latest = await ctx.db
    .query("cases")
    .withIndex("by_app_and_signature", (q) => q.eq("appId", appId).eq("signature", `journey_failed:${journeyId}`))
    .order("desc")
    .first();
  return Boolean(latest && !NOT_OPEN.includes(latest.status));
}

export const forProject = query({
  args: { projectId: v.string() },
  returns: v.union(v.null(), vOverview),
  handler: async (ctx, { projectId }) => {
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId ? await visibleApp(ctx, appId) : null;
    if (!app || app.isSample) return null;

    const journeys = await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", app._id)).take(MAX_CHECKS);
    const checks: Infer<typeof vWatchedCheck>[] = await Promise.all(journeys.map(async (journey) => ({
      id: journey._id as string,
      kind: "journey" as const,
      name: journey.name,
      state: (await journeyFailing(ctx, app._id, journey._id)) ? "failing" as const : journey.lastPassedAt === undefined ? "waiting" as const : "passing" as const,
      ...(journey.lastPassedAt !== undefined && { lastPassedAt: journey.lastPassedAt }),
    })));

    const preparation = await preparationFor(ctx, app._id);
    let stage: "none" | "in_progress" | "done" | "unreadable" = "none";
    if (preparation) {
      // The endpoints the preparation registered that are not journeys (those are listed above): health, readiness, flags.
      for (const check of preparation.registration?.checks ?? []) {
        if (check.journeyId || check.kind === "journey" || check.kind === "recovery_hook" || checks.length >= MAX_CHECKS) continue;
        checks.push({
          id: `${check.kind}:${check.url}`,
          kind: check.kind,
          name: check.name,
          state: check.state === "works" ? "passing" : "failing",
          ...(check.state === "works" && { lastPassedAt: check.checkedAt }),
        });
      }
      const current = stageOf(await latestInspection(ctx, app._id), preparation);
      stage = current === "inspection_failed" ? "unreadable"
        : current === "registered" || current === "nothing_to_add" || current === "unsupported" ? "done" : "in_progress";
    }

    return { checks, preparation: stage, map: await codeMap(ctx, app) };
  },
});
