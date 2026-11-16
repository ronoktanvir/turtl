import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { BOOKING_APP_NAME } from "../protectedApp/registry";
import { replaceNetwork } from "./network";
import { codeNamespace } from "./schema";
import { SEED_NETWORK } from "./seed";

declare const process: { env: Record<string, string | undefined> };

// Stores the network of this repository, built once and kept in seed.ts, for a project; defaults to the registered booking app.
// Questions need its code in Supermemory too: run codeNetwork/build:build with reuseLabels on a deployment with SUPERMEMORY_API_KEY.
export const loadSeed = mutation({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (process.env.DEV_TOOLS_ENABLED !== "true") throw new Error("Dev tools are disabled on this deployment.");
    const projectId =
      args.projectId ??
      (await ctx.db
        .query("apps")
        .filter((q) => q.eq(q.field("name"), BOOKING_APP_NAME))
        .first())?._id;
    if (!projectId) {
      throw new Error("No booking app is registered. Run dev:registerBooking first, or pass projectId.");
    }
    await replaceNetwork(ctx, {
      projectId,
      repo: SEED_NETWORK.repo,
      ref: SEED_NETWORK.ref,
      namespace: codeNamespace(projectId),
      source: "seed",
      generatedAt: SEED_NETWORK.generatedAt,
      clusters: SEED_NETWORK.clusters,
      nodes: SEED_NETWORK.nodes,
      edges: SEED_NETWORK.edges,
    });
    return {
      projectId,
      clusters: SEED_NETWORK.clusters.length,
      nodes: SEED_NETWORK.nodes.length,
      edges: SEED_NETWORK.edges.length,
    };
  },
});
