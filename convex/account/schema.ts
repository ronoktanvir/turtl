import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

// The record of one account deletion (convex/account/README.md). While the job runs it holds the account id, so the
// job can resume; once the job is done it keeps only a hash of that id, when it was asked for and when it finished,
// and counts, so "was this account deleted, and when" can still be answered and nothing personal is left.

export const vDeletionStage = v.union(
  v.literal("stop"), // ending sign-in, closing cases, switching off the monitor and the report form
  v.literal("settle"), // waiting until no action that started before the stop can still be running
  v.literal("erase"), // copies at vendors first, then every project, then the account's own rows
  v.literal("waiting"), // everything in turtl's database is gone; a vendor deletion is being retried
  v.literal("done"),
);

export const vVendorService = v.union(v.literal("supermemory"), v.literal("github"), v.literal("apple"));

/** One deletion at a vendor. target: the Supermemory namespace (a name built from a project id, nothing personal). */
export const vVendorTask = v.object({
  service: vVendorService,
  target: v.optional(v.string()),
  state: v.union(v.literal("pending"), v.literal("done"), v.literal("skipped")),
  tries: v.number(),
  nextAt: v.number(),
  note: v.optional(v.string()),
});

export const vRemoved = v.object({ projects: v.number(), cases: v.number(), rows: v.number(), files: v.number() });

export type VendorTask = Infer<typeof vVendorTask>;
export type DeletionStage = Infer<typeof vDeletionStage>;

export const accountDeletionTables = {
  accountDeletions: defineTable({
    /** The users id being deleted. Removed when the job is done. */
    account: v.optional(v.string()),
    /** SHA-256 of the account id, kept after the job so a deleted account can be looked up. */
    accountHash: v.string(),
    status: v.union(v.literal("running"), v.literal("done")),
    stage: vDeletionStage,
    requestedAt: v.number(),
    updatedAt: v.number(),
    /** When the job should next run. The resume cron restarts a job whose wakeAt has long passed. */
    wakeAt: v.number(),
    settleUntil: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    /** Stop stage: creation time of the last project finished, and of the last case looked at in the current one. */
    stopped: v.optional(v.object({ project: v.number(), cases: v.number() })),
    /** Erase stage: the project being erased, and the names of the registry's call entries that have finished for it. */
    current: v.optional(v.object({ appId: v.optional(v.string()), calls: v.array(v.string()) })),
    vendors: v.array(vVendorTask),
    removed: vRemoved,
    /** One running driver at a time (convex/account/deletion.ts:run). */
    lease: v.optional(v.object({ driver: v.string(), until: v.number() })),
    lastError: v.optional(v.string()),
  })
    .index("by_account", ["account"])
    .index("by_account_hash", ["accountHash"])
    .index("by_status_and_wake", ["status", "wakeAt"]),
};
