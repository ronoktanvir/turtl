import { defineTable } from "convex/server";
import { v } from "convex/values";

export const watchingTables = {
  // With accounts on, the monitor's state for one project (convex/protectedApp/watching.ts): whether its check is
  // running, when it last ran, and why it is not watched or only partly watched. One row per project, written only
  // when something changes.
  //
  // Only a project that has checks gets a row. nextCheckAt is when it is next due; the monitor claims due rows through
  // by_next_check, so projects with nothing to check never take a turn (second review, finding 15). A row without it
  // (written before it existed) is due now. failure: the same failure seen on `streak` checks in a row, which spaces
  // the checks out (watching.ts, intervalAfter).
  watchedProjects: defineTable({
    appId: v.id("apps"),
    runningSince: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    nextCheckAt: v.optional(v.number()),
    failure: v.optional(v.object({ signature: v.string(), streak: v.number(), since: v.number() })),
    notice: v.optional(v.object({ reason: v.string(), at: v.number(), partial: v.boolean() })),
  })
    .index("by_app", ["appId"])
    .index("by_next_check", ["nextCheckAt"]),
  // One row. journeysAfter: the creation time of the last check the monitor has looked at, so a project whose checks
  // were added without a row (before rows were kept, or by a path that does not make one) is found and becomes due.
  // after: where the earlier sweep over every project stood; no longer read.
  monitorCursor: defineTable({ after: v.number(), at: v.number(), journeysAfter: v.optional(v.number()) }),
};
