import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { projectSecret } from "../secrets/store";
import { liveAddressProblem } from "./address";

// Which projects the monitor checks with accounts on (AUTH_REQUIRED=true), and in what turn. The single-owner demo does
// not use this file: its monitor checks the one demo app named by PROTECTED_APP_URL, as before.
//
// Each tick takes the next PROJECTS_PER_TICK projects in creation order, from a cursor that wraps, so every project gets
// its turn however many there are and however many checks each has. A project that can be checked gets its own action
// (monitor:checkProject), so one slow app never holds up another. A project that cannot be checked (its owner deleted
// their account, it has no usable live address, or its checks need a control token it does not have) is not checked
// at all: its reason is recorded once, shown to its owner, and read again on its next turn, with nothing sent.

export const PROJECTS_PER_TICK = 25;
/** More checks than a turtl.json registers (MAX_MANIFEST_ENTRIES per list, plus health and readiness). */
export const MAX_JOURNEYS = 25;
/** A check still running after this long is taken to have stopped, and the project gets its turn again. */
export const LEASE_MS = 5 * 60_000;

export const WATCH_WORDS = {
  noOwner: "turtl does not know whose project this is, so it does not watch it.",
  ownerGone: "Its owner deleted their account, so turtl no longer watches it.",
  noAddress: "It has no live address, so turtl has nothing to check.",
  noToken: "No control token is set, so turtl cannot run this project's checks. Add it in this project's Settings, under Control token.",
  someNeedToken: "Some of this project's checks need the control token, so turtl runs only the others until you add it in this project's Settings, under Control token.",
};

type Read = Pick<QueryCtx, "db">;
type Http = Extract<Doc<"journeys">["check"], { kind: "http" }>;
export type Runnable = { journeyId: Id<"journeys">; url: string; credentialRef?: string };
type Plan = { kind: "none" } | { kind: "skip"; reason: string } | { kind: "run"; base: string; journeys: Runnable[]; partial: string | null };

/** What the monitor can check for one project now, read from its own rows. */
export async function planFor(ctx: Read, app: Doc<"apps">): Promise<Plan> {
  if (app.isSample) return { kind: "none" };
  const journeys = (await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", app._id)).take(MAX_JOURNEYS)).flatMap((journey) =>
    journey.check.kind === "http" ? [{ journeyId: journey._id, ...pick(journey.check) }] : [],
  );
  if (journeys.length === 0) return { kind: "none" };
  const skip = (reason: string): Plan => ({ kind: "skip", reason });
  if (!app.ownerId) return skip(WATCH_WORDS.noOwner);
  const owner = ctx.db.normalizeId("users", app.ownerId);
  if (!owner || !(await ctx.db.get(owner))) return skip(WATCH_WORDS.ownerGone);
  if (!app.productionUrl) return skip(WATCH_WORDS.noAddress);
  const problem = liveAddressProblem(app.productionUrl);
  if (problem) return skip(problem);
  const hasToken = (await projectSecret(ctx, app._id, "control_token")) !== null;
  const runnable = journeys.filter((journey) => hasToken || !journey.credentialRef);
  if (runnable.length === 0) return skip(WATCH_WORDS.noToken);
  return { kind: "run", base: app.productionUrl.replace(/\/+$/, ""), journeys: runnable, partial: runnable.length < journeys.length ? WATCH_WORDS.someNeedToken : null };
}

const pick = (check: Http): Omit<Runnable, "journeyId"> => ({ url: check.config.url, ...(check.config.credentialRef && { credentialRef: check.config.credentialRef }) });

const stateOf = (ctx: Read, appId: Id<"apps">) => ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).first();

async function writeState(ctx: Pick<MutationCtx, "db">, appId: Id<"apps">, row: Doc<"watchedProjects"> | null, fields: Partial<Omit<Doc<"watchedProjects">, "_id" | "_creationTime" | "appId">>) {
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("watchedProjects", { appId, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });
}

const sameNotice = (row: Doc<"watchedProjects"> | null, reason: string | null) => (row?.notice?.reason ?? null) === reason;

/** Why the monitor is not checking a project, or checks only some of it, for its owner to read. Null when all is checked. */
export async function watchNotice(ctx: Read, appId: Id<"apps">): Promise<string | null> {
  return (await stateOf(ctx, appId))?.notice?.reason ?? null;
}

// One tick's turn: takes the next projects, records why any cannot be checked, and starts a check for each that can.
export const claim = internalMutation({
  args: {},
  returns: v.object({ started: v.array(v.id("apps")), skipped: v.array(v.object({ appId: v.id("apps"), reason: v.string() })), wrapped: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cursor = await ctx.db.query("monitorCursor").first();
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor?.after ?? 0))
      .take(PROJECTS_PER_TICK);
    const wrapped = apps.length < PROJECTS_PER_TICK;
    const after = wrapped ? 0 : apps[apps.length - 1]._creationTime;
    if (cursor) await ctx.db.patch(cursor._id, { after, at: now });
    else await ctx.db.insert("monitorCursor", { after, at: now });

    const started: Id<"apps">[] = [];
    const skipped: { appId: Id<"apps">; reason: string }[] = [];
    for (const app of apps) {
      const plan = await planFor(ctx, app);
      if (plan.kind === "none") continue;
      const row = await stateOf(ctx, app._id);
      if (plan.kind === "skip") {
        skipped.push({ appId: app._id, reason: plan.reason });
        if (!sameNotice(row, plan.reason)) await writeState(ctx, app._id, row, { notice: { reason: plan.reason, at: now, partial: false } });
        continue;
      }
      if (row?.runningSince !== undefined && now - row.runningSince < LEASE_MS) continue;
      await writeState(ctx, app._id, row, {
        runningSince: now,
        ...(!sameNotice(row, plan.partial) && { notice: plan.partial ? { reason: plan.partial, at: now, partial: true } : undefined }),
      });
      await ctx.scheduler.runAfter(0, internal.monitor.checkProject, { appId: app._id });
      started.push(app._id);
    }
    return { started, skipped, wrapped };
  },
});

// What one project's check runs now: its live address and the checks it can run. Null when it cannot be checked.
export const plan = internalQuery({
  args: { appId: v.id("apps") },
  returns: v.union(
    v.null(),
    v.object({ base: v.string(), journeys: v.array(v.object({ journeyId: v.id("journeys"), url: v.string(), credentialRef: v.optional(v.string()) })) }),
  ),
  handler: async (ctx, { appId }) => {
    const app = await ctx.db.get(appId);
    const found = app ? await planFor(ctx, app) : null;
    return found?.kind === "run" ? { base: found.base, journeys: found.journeys } : null;
  },
});

export const finish = internalMutation({
  args: { appId: v.id("apps"), checkedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { appId, checkedAt }) => {
    const row = await stateOf(ctx, appId);
    if (row) await ctx.db.patch(row._id, { runningSince: undefined, lastCheckedAt: checkedAt });
    return null;
  },
});

// Eraser for deleting a project (convex/account/): its monitor state.
export const forgetProject = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, { appId }) => {
    const rows = await ctx.db.query("watchedProjects").withIndex("by_app", (q) => q.eq("appId", appId)).take(10);
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});
