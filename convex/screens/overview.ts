import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx } from "../_generated/server";
import { query } from "../functions";
import { accessEnforced, visibleApp, visibleApps } from "../access";
import { CLOSED_CASE_STATUSES } from "../constants";
import { latestInspection, preparationFor } from "../onboarding/records";
import { isNotAnswering } from "../protectedApp/notAnswering";
import { liveChecks, probeOf } from "../protectedApp/watching";
import { stageOf } from "../onboarding/stage";

// What turtl is watching on one project before anything has gone wrong: the checks turtl runs on it and when each
// last passed, whether the preparation is still under way, and how much of its code is mapped. Read-only. A check
// registration retired, because the project's turtl.json no longer lists it, is not here.

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
  // A failing check with no issue open: how its last issue ended, so the empty Fix list can say why none is open.
  closedAs: v.optional(v.union(v.literal("declined"), v.literal("unresolved"))),
  // A check that is not answering: its last `tries` tries in a row, the first at `since`, got no usable reply
  // (convex/protectedApp/notAnswering.ts). Its state is then "failing". Absent below UNANSWERED_AFTER in a row.
  // notReady: the latest of them was a readiness check's "not ready", the app's own word that it cannot serve customers.
  notAnswering: v.optional(v.object({ since: v.number(), tries: v.number(), notReady: v.optional(v.boolean()) })),
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

async function journeyFailing(ctx: QueryCtx, appId: Id<"apps">, journey: Pick<Doc<"journeys">, "_id" | "lastPassedAt">) {
  const latest = await ctx.db
    .query("cases")
    .withIndex("by_app_and_signature", (q) => q.eq("appId", appId).eq("signature", `journey_failed:${journey._id}`))
    .order("desc")
    .first();
  if (!latest) return { failing: false } as const;
  if (!NOT_OPEN.includes(latest.status)) return { failing: true } as const;
  // A case declined or left unresolved fixed nothing: the check is still failing until it passes again after it.
  if ((latest.status === "declined" || latest.status === "unresolved") && (journey.lastPassedAt ?? 0) < latest._creationTime) {
    return { failing: true, closedAs: latest.status } as const;
  }
  return { failing: false } as const;
}

export const forProject = query({
  args: { projectId: v.string() },
  returns: v.union(v.null(), vOverview),
  handler: async (ctx, { projectId }) => {
    const appId = ctx.db.normalizeId("apps", projectId);
    const app = appId ? await visibleApp(ctx, appId) : null;
    if (!app || app.isSample) return null;

    const journeys = await liveChecks(ctx, app._id, MAX_CHECKS);
    const checks: Infer<typeof vWatchedCheck>[] = await Promise.all(journeys.map(async (journey) => {
      const failing = await journeyFailing(ctx, app._id, journey);
      // A practice project's app is turtl's own: it is never shown as not answering (protectedApp/notAnswering.ts).
      const quiet = !app.practice && isNotAnswering(journey) && journey.unanswered
        ? { since: journey.unanswered.since, tries: journey.unanswered.count, ...(journey.unanswered.latest.kind === "not_ready" && { notReady: true }) }
        : null;
      return {
        id: journey._id as string,
        // A health or readiness check turtl sends as a GET each round says which it is; the rest are journey checks.
        kind: probeOf(journey) ?? ("journey" as const),
        name: journey.name,
        state: failing.failing || quiet ? "failing" as const : journey.lastPassedAt === undefined ? "waiting" as const : "passing" as const,
        ...(journey.lastPassedAt !== undefined && { lastPassedAt: journey.lastPassedAt }),
        ...("closedAs" in failing && { closedAs: failing.closedAs }),
        ...(quiet && { notAnswering: quiet }),
      };
    }));

    const preparation = await preparationFor(ctx, app._id);
    let stage: "none" | "in_progress" | "done" | "unreadable" = "none";
    if (preparation) {
      // What the preparation's last check of the live app found that is not a check turtl runs (those are listed above):
      // flags, and a health or readiness endpoint that did not answer then, each as it stood at that check.
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
