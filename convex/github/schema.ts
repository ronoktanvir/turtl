import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vInstallationStatus = v.union(v.literal("active"), v.literal("suspended"), v.literal("deleted"));
export const vInstallation = v.object({
  installationId: v.number(),
  accountLogin: v.string(),
  repositorySelection: v.union(v.literal("all"), v.literal("selected")),
  // "User" or "Organization", as GitHub names the account the installation is on.
  accountType: v.optional(v.string()),
});
export const vRepository = v.object({ fullName: v.string(), private: v.optional(v.boolean()) });
export const vConnectStatus = v.union(v.literal("started"), v.literal("claimed"), v.literal("confirmed"), v.literal("finished"), v.literal("failed"));
// Why a repository GitHub listed for the person is not in their link: they can only read it, they could change it
// once and no longer can, or the link already holds as many repositories as one link may.
export const vLeftOutWhy = v.union(v.literal("read_only"), v.literal("lost"), v.literal("too_many"));
export const vLeftOut = v.object({ fullName: v.string(), why: vLeftOutWhy });

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
  // One Connect GitHub attempt, started by a turtl account. The state and ticket are stored only as SHA-256 hashes.
  // The code verifier is the PKCE secret for the one authorization this attempt asks GitHub for.
  githubConnectAttempts: defineTable({
    account: v.string(),
    stateHash: v.string(),
    codeVerifier: v.string(),
    returnTo: v.string(),
    status: vConnectStatus,
    expiresAt: v.number(),
    ticketHash: v.optional(v.string()),
    githubUserId: v.optional(v.number()),
    githubLogin: v.optional(v.string()),
  })
    .index("by_state", ["stateHash"])
    .index("by_ticket", ["ticketHash"])
    .index("by_account", ["account"]),
  // Which turtl account may use which installation. Written inactive when GitHub confirms the person who came back,
  // and made active only when the account that started the attempt finishes it in the app.
  githubInstallationLinks: defineTable({
    account: v.string(),
    installationId: v.number(),
    attemptId: v.id("githubConnectAttempts"),
    active: v.boolean(),
    // The GitHub user GitHub confirmed, by the id that never changes; turtl asks GitHub what this user may do now.
    githubUserId: v.number(),
    // Their login when last seen. Logins can change, so it is only shown, never trusted.
    githubLogin: v.string(),
    // Absent: the installation is on this GitHub user's own account, so every repository it covers is theirs.
    // Present: the repositories (lowercase owner/name) in it that this GitHub user could change (push, maintain or
    // admin) when turtl last asked GitHub. With accounts on, a repository they can only read is never here.
    repositories: v.optional(v.array(v.string())),
    // When GitHub last confirmed that this user can change every repository listed above. Absent on links made before
    // turtl asked (they may list repositories the person can only read), which are checked before they are used.
    checkedAt: v.optional(v.number()),
    // What GitHub listed for this user but turtl left out, and why, so the app can say why a repository is missing.
    leftOut: v.optional(v.array(vLeftOut)),
    confirmedAt: v.number(),
  })
    .index("by_account_and_installation", ["account", "installationId"])
    .index("by_installation", ["installationId"])
    .index("by_attempt", ["attemptId"]),
};
