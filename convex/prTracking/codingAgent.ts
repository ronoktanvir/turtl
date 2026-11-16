import type { ActionCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { repositoryAccess } from "../github/access";
import { openSecret } from "../secrets/open";
import { CONNECT_CODING_AGENT } from "../secrets/words";
import { capyConfig, type CapyConfig } from "./capy";

// Which coding agent works for a project, the one place that decides it.
//
// Single-owner demo (AUTH_REQUIRED unset): the deployment's CAPY_API_KEY, as before (capyConfig in capy.ts).
// With accounts on: the project owner's own Capy key (convex/secrets/account.ts), opened here in the action that sends
// it, and never the deployment's CAPY_API_KEY, CAPY_PROJECT_ID or model settings, which belong to the deployment's own
// Capy account. Without one, a plain sentence saying how to connect it; everything that needs no coding agent
// (watching, diagnosis, flag recoveries, following and merging pull requests on GitHub) carries on.

const UNREADABLE_KEY =
  "turtl could not open your coding agent's key, because the backend's encryption key changed since you added it. Add it again in Settings (the gear), under Coding agent.";

/** No GitHub App on the backend: with accounts on, turtl reaches no repository on an owner's behalf. */
export const NO_GITHUB_CONNECTION = (repo: string) =>
  `turtl can reach ${repo} only through GitHub connected to your account, and this backend has no GitHub connection set up.`;

type Scope = { appId: string } | { caseId: string };

/** The coding agent for following a thread that already started: the owner's own key, or the demo's. */
export async function capyConfigFor(ctx: Pick<ActionCtx, "runQuery">, scope: Scope): Promise<CapyConfig> {
  if (!accessEnforced()) return capyConfig();
  const opened = await openSecret(ctx, "coding_agent_key", scope);
  if (opened.ok) return { ok: true, apiKey: opened.value, own: true };
  return { ok: false, missing: ["your coding agent's key (Settings, Coding agent)"], reason: opened.why === "missing" ? CONNECT_CODING_AGENT : UNREADABLE_KEY };
}

/**
 * The coding agent for starting a thread in `repo` for a project. With accounts on it also needs the repository to be
 * covered by a GitHub installation linked to the project's owner (repositoryAccess), so no account can point its agent,
 * or anyone's, at a repository it has not connected to turtl; turtl could not follow or merge the result anyway.
 */
export async function codingAgentFor(ctx: ActionCtx, scope: { appId: string }, repo: string): Promise<CapyConfig> {
  const capy = await capyConfigFor(ctx, scope);
  if (!capy.ok || !accessEnforced()) return capy;
  const access = await repositoryAccess(ctx, repo, scope);
  if (access.ok && access.source === "installation") return capy;
  return { ok: false, missing: ["a GitHub connection that covers " + repo], reason: access.ok ? NO_GITHUB_CONNECTION(repo) : access.message };
}
