import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireDevTools } from "../access";
import { BOOKING_APP_NAME } from "../protectedApp/registry";
import { replaceNetwork } from "./network";
import { codeNamespace } from "./schema";
import { SEED_NETWORK } from "./seed";

// Stores the network of this repository, built once and kept in seed.ts, for a project; defaults to the registered booking app.
// Questions need its code in Supermemory too: run codeNetwork/build:build with reuseLabels on a deployment with SUPERMEMORY_API_KEY.
// Dev tools: closed unless DEV_TOOLS_ENABLED=true, and always closed with accounts on (convex/access.ts).
export const loadSeed = mutation({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireDevTools();
    const projectId =
      args.projectId ??
      (await ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", BOOKING_APP_NAME))
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
