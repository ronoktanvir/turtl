import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vInstallationStatus = v.union(v.literal("active"), v.literal("suspended"), v.literal("deleted"));
export const vInstallation = v.object({
  installationId: v.number(),
  accountLogin: v.string(),
  repositorySelection: v.union(v.literal("all"), v.literal("selected")),
});
export const vRepository = v.object({ fullName: v.string(), private: v.optional(v.boolean()) });

export const githubTables = {
  // One row per installation of turtl's GitHub App on a GitHub account. A deleted installation keeps its row and never becomes active again.
  githubInstallations: defineTable({
    ...vInstallation.fields,
    status: vInstallationStatus,
    updatedAt: v.number(),
  }).index("by_installation", ["installationId"]),
  // The repositories an installation covers. These rows route a repository to its installation; GitHub still decides what a token can reach.
  githubInstallationRepositories: defineTable({
    installationId: v.number(),
    fullName: v.string(),
    fullNameLower: v.string(),
    private: v.optional(v.boolean()),
    seenAt: v.number(),
  })
    .index("by_full_name", ["fullNameLower"])
    .index("by_installation_and_seen", ["installationId", "seenAt"]),
  // Installation tokens, kept until shortly before they expire. Only github/tokens.ts touches this table, and no public function may return a row.
  githubInstallationTokens: defineTable({
    installationId: v.number(),
    token: v.string(),
    expiresAt: v.number(),
  }).index("by_installation", ["installationId"]),
  // Webhook deliveries already applied, by GitHub's delivery id and by a digest of the signed body, so a replay changes nothing.
  githubWebhookDeliveries: defineTable({
    deliveryId: v.string(),
    bodyDigest: v.string(),
    event: v.string(),
    action: v.string(),
    installationId: v.number(),
    receivedAt: v.number(),
  })
    .index("by_delivery", ["deliveryId"])
    .index("by_digest", ["bodyDigest"]),
};
