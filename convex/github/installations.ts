import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { vInstallation, vInstallationStatus, vRepository } from "./schema";
import type { Installation, Repository } from "./shapes";
import { clearToken } from "./tokens";

const DROP_BATCH = 500;

const installationRow = (ctx: QueryCtx, installationId: number) =>
  ctx.db
    .query("githubInstallations")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .unique();

const repositoryRows = (ctx: QueryCtx, fullName: string) =>
  ctx.db
    .query("githubInstallationRepositories")
    .withIndex("by_full_name", (q) => q.eq("fullNameLower", fullName.toLowerCase()))
    .collect();

async function saveInstallation(ctx: MutationCtx, installation: Installation, status: "active" | "suspended" | "deleted") {
  const row = await installationRow(ctx, installation.installationId);
  if (row) await ctx.db.patch(row._id, { ...installation, status, updatedAt: Date.now() });
  else await ctx.db.insert("githubInstallations", { ...installation, status, updatedAt: Date.now() });
}

async function saveRepositories(ctx: MutationCtx, installationId: number, repositories: Repository[], seenAt: number) {
  for (const repository of repositories) {
    const row = (await repositoryRows(ctx, repository.fullName)).find((candidate) => candidate.installationId === installationId);
    if (row) await ctx.db.patch(row._id, { ...repository, seenAt });
    else await ctx.db.insert("githubInstallationRepositories", { installationId, ...repository, fullNameLower: repository.fullName.toLowerCase(), seenAt });
  }
}

// Deletes one batch of an installation's repository rows, all of them or only those last seen before a
// refresh began, and schedules itself again while a full batch suggests more remain.
async function dropBatch(ctx: MutationCtx, installationId: number, before?: number) {
  const rows = await ctx.db
    .query("githubInstallationRepositories")
    .withIndex("by_installation_and_seen", (q) => {
      const ofInstallation = q.eq("installationId", installationId);
      return before === undefined ? ofInstallation : ofInstallation.lt("seenAt", before);
    })
    .take(DROP_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === DROP_BATCH) {
    await ctx.scheduler.runAfter(0, internal.github.installations.dropRepositories, { installationId, ...(before !== undefined && { before }) });
  }
}

// The active installation that covers a repository, by turtl's records, or null.
export const covering = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, { repo }): Promise<number | null> => {
    const rows = (await repositoryRows(ctx, repo)).sort((a, b) => b.seenAt - a.seenAt);
    for (const row of rows) {
      if ((await installationRow(ctx, row.installationId))?.status === "active") return row.installationId;
    }
    return null;
  },
});

// The repositories an installation covers, by name, for the repository picker. Empty unless the installation is active.
export const repositories = internalQuery({
  args: { installationId: v.number() },
  handler: async (ctx, { installationId }): Promise<Repository[]> => {
    if ((await installationRow(ctx, installationId))?.status !== "active") return [];
    const rows = await ctx.db
      .query("githubInstallationRepositories")
      .withIndex("by_installation_and_seen", (q) => q.eq("installationId", installationId))
      .collect();
    return rows
      .map((row) => ({ fullName: row.fullName, ...(row.private !== undefined && { private: row.private }) }))
      .sort((a, b) => a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()));
  },
});

// Applies one verified webhook delivery, once. A delivery id or a signed body seen before changes nothing, and
// neither does a delivery for an installation already deleted, because GitHub never brings an installation id back.
export const receive = internalMutation({
  args: {
    deliveryId: v.string(),
    bodyDigest: v.string(),
    event: v.string(),
    action: v.string(),
    installation: vInstallation,
    status: v.union(vInstallationStatus, v.null()),
    added: v.array(vRepository),
    removed: v.array(v.string()),
    resync: v.boolean(),
  },
  handler: async (ctx, { deliveryId, bodyDigest, event, action, installation, status, added, removed, resync }): Promise<"applied" | "duplicate" | "ignored"> => {
    const { installationId } = installation;
    const replayed =
      (await ctx.db.query("githubWebhookDeliveries").withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId)).first()) ??
      (await ctx.db.query("githubWebhookDeliveries").withIndex("by_digest", (q) => q.eq("bodyDigest", bodyDigest)).first());
    if (replayed) return "duplicate";
    const now = Date.now();
    await ctx.db.insert("githubWebhookDeliveries", { deliveryId, bodyDigest, event, action, installationId, receivedAt: now });
    const known = await installationRow(ctx, installationId);
    if (known?.status === "deleted") return "ignored";

    const next = status ?? known?.status ?? "active";
    await saveInstallation(ctx, installation, next);
    await clearToken(ctx, installationId);
    if (next === "deleted") {
      await dropBatch(ctx, installationId);
      return "applied";
    }
    await saveRepositories(ctx, installationId, added, now);
    for (const fullName of removed) {
      const row = (await repositoryRows(ctx, fullName)).find((candidate) => candidate.installationId === installationId);
      if (row) await ctx.db.delete(row._id);
    }
    // A switch between all and selected repositories does not list what was lost, and a very long list is not
    // applied here, so both are read back from GitHub.
    if (next === "active" && (resync || (known && known.repositorySelection !== installation.repositorySelection))) {
      await ctx.scheduler.runAfter(0, internal.github.sync.refresh, { installationId });
    }
    return "applied";
  },
});

// Writes what GitHub's API just said about an installation and some of its repositories.
export const record = internalMutation({
  args: {
    installation: vInstallation,
    status: v.union(v.literal("active"), v.literal("suspended")),
    repositories: v.array(vRepository),
    seenAt: v.number(),
  },
  handler: async (ctx, { installation, status, repositories, seenAt }) => {
    await saveInstallation(ctx, installation, status);
    if (status === "suspended") return await clearToken(ctx, installation.installationId);
    await saveRepositories(ctx, installation.installationId, repositories, seenAt);
  },
});

export const markDeleted = internalMutation({
  args: { installationId: v.number() },
  handler: async (ctx, { installationId }) => {
    const row = await installationRow(ctx, installationId);
    if (row && row.status !== "deleted") await ctx.db.patch(row._id, { status: "deleted", updatedAt: Date.now() });
    await clearToken(ctx, installationId);
    await dropBatch(ctx, installationId);
  },
});

export const dropRepositories = internalMutation({
  args: { installationId: v.number(), before: v.optional(v.number()) },
  handler: async (ctx, { installationId, before }) => dropBatch(ctx, installationId, before),
});
