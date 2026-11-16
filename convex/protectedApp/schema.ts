import { defineTable } from "convex/server";
import { v } from "convex/values";

export const watchingTables = {
  // With accounts on, the monitor's state for one project (convex/protectedApp/watching.ts): whether its check is
  // running, when it last ran, and why it is not watched or only partly watched. One row per project, written only
  // when something changes.
  watchedProjects: defineTable({
    appId: v.id("apps"),
    runningSince: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    notice: v.optional(v.object({ reason: v.string(), at: v.number(), partial: v.boolean() })),
  }).index("by_app", ["appId"]),
  // Where the monitor's sweep over projects stands: the creation time of the last project it took. One row.
  monitorCursor: defineTable({ after: v.number(), at: v.number() }),
};
