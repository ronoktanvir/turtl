import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import { githubToken } from "../prTracking/github";
import { readApp, readRepositoryInstallation } from "./api";
import manifest from "./app-manifest.json";
import { appConfig, GITHUB_APP_VARIABLES, REPOSITORY_PATTERN } from "./config";
import { signAppJwt, UNREADABLE_KEY } from "./jwt";
import { installationToken } from "./tokens";

declare const process: { env: Record<string, string | undefined> };

export type RepositoryAccess =
  | { ok: true; source: "installation"; token: string; installationId: number }
  // The GitHub App is not configured: the deployment's GITHUB_TOKEN, or no token at all when that is not set either.
  | { ok: true; source: "deployment"; token: string | undefined }
  | { ok: false; reason: "invalid_repository" | "app_incomplete" | "not_installed" | "suspended" | "github_error"; message: string };

// The one place that decides which credential reaches a repository ("owner/name").
// With the GitHub App configured, only an installation that covers the repository gives a token, and
// GITHUB_TOKEN is never used. Without it, every repository gets the deployment's GITHUB_TOKEN, as before.
export async function repositoryAccess(ctx: ActionCtx, repo: string): Promise<RepositoryAccess> {
  const app = appConfig();
  if (app.state === "absent") return { ok: true, source: "deployment", token: githubToken() };
  if (app.state === "incomplete") {
    return { ok: false, reason: "app_incomplete", message: `turtl's GitHub App is partly configured: ${app.missing.join(" and ")} is not set on the deployment.` };
  }
  if (!REPOSITORY_PATTERN.test(repo)) return { ok: false, reason: "invalid_repository", message: `"${repo}" is not a repository in owner/name form.` };
  const jwt = await signAppJwt(app.appId, app.privateKey);
  if (!jwt) return { ok: false, reason: "app_incomplete", message: UNREADABLE_KEY };

  let installationId: number | null = await ctx.runQuery(internal.github.installations.covering, { repo });
  if (installationId === null) {
    // turtl's records say no. GitHub has the last word, so a missed webhook or a renamed repository heals here.
    const found = await readRepositoryInstallation(jwt, repo);
    if (!found.ok) {
      return found.status === 404
        ? { ok: false, reason: "not_installed", message: `turtl's GitHub App is not installed on ${repo}. Connect the repository in turtl, or add it to the installation on GitHub.` }
        : { ok: false, reason: "github_error", message: found.message };
    }
    const { suspended, ...installation } = found.body;
    await ctx.runMutation(internal.github.installations.record, {
      installation,
      status: suspended ? "suspended" : "active",
      repositories: [{ fullName: repo }],
      seenAt: Date.now(),
    });
    if (suspended) {
      return { ok: false, reason: "suspended", message: `${installation.accountLogin} has suspended turtl's GitHub App, so turtl cannot reach ${repo}.` };
    }
    installationId = installation.installationId;
  }

  const token = await installationToken(ctx, jwt, installationId);
  if (!token.ok) {
    return token.status === 404
      ? { ok: false, reason: "not_installed", message: `turtl's GitHub App is no longer installed on ${repo}.` }
      : { ok: false, reason: "github_error", message: token.message };
  }
  return { ok: true, source: "installation", token: token.body, installationId };
}

// Says what is configured and whether GitHub accepts it, without returning any secret. With a repository it
// also says which credential that repository would get.
// Run: npx convex run github/access:check '{"repo":"owner/name"}'
export const check = internalAction({
  args: { repo: v.optional(v.string()) },
  handler: async (ctx, { repo }) => {
    const app = appConfig();
    const jwt = app.state === "ready" ? await signAppJwt(app.appId, app.privateKey) : null;
    const read = jwt ? await readApp(jwt) : null;
    const expected: Record<string, string> = manifest.default_permissions;
    const access = repo === undefined ? null : await repositoryAccess(ctx, repo);
    return {
      app: app.state,
      variables: Object.fromEntries(
        [...GITHUB_APP_VARIABLES, "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "GITHUB_TOKEN"].map((name) => [name, process.env[name] ? "set" : "not set"]),
      ),
      github:
        app.state !== "ready"
          ? null
          : !read
            ? { ok: false, message: UNREADABLE_KEY }
            : !read.ok
              ? { ok: false, message: read.message }
              : {
                  ok: true,
                  slug: read.body.slug,
                  slugMatches: read.body.slug === process.env.GITHUB_APP_SLUG,
                  permissions: read.body.permissions,
                  permissionsMatch:
                    Object.keys(read.body.permissions).length === Object.keys(expected).length &&
                    Object.entries(expected).every(([name, level]) => read.body.permissions[name] === level),
                  events: read.body.events,
                },
      repository:
        access &&
        (access.ok
          ? { ok: true, source: access.source, ...(access.source === "installation" ? { installationId: access.installationId } : { hasToken: access.token !== undefined }) }
          : access),
    };
  },
});
