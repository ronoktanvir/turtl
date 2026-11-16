import { defineTable } from "convex/server";
import { v } from "convex/values";

/** control_token: a project's own token for its app's protected routes. coding_agent_key: an account's Capy API key. */
export const vSecretKind = v.union(v.literal("control_token"), v.literal("coding_agent_key"));
export type SecretKind = "control_token" | "coding_agent_key";

export const secretTables = {
  // What an owner entrusts to turtl, sealed with AES-GCM under SECRETS_ENCRYPTION_KEY (convex/secrets/seal.ts).
  // Write-only: no public function returns `sealed`; it is opened only inside the action that sends it. A project's
  // secret has appId and the account that owned the project when it was set; an account's secret has no appId.
  secrets: defineTable({
    kind: vSecretKind,
    account: v.string(),
    appId: v.optional(v.id("apps")),
    sealed: v.string(),
    keyId: v.string(),
    setAt: v.number(),
  })
    .index("by_app_and_kind", ["appId", "kind"])
    .index("by_account_and_kind", ["account", "kind"]),
};
