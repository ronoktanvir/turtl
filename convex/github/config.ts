declare const process: { env: Record<string, string | undefined> };

export const GITHUB_APP_VARIABLES = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"] as const;
export const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export type ReadyApp = { state: "ready"; appId: string; privateKey: string };
export type AppConfig = { state: "absent" } | { state: "incomplete"; missing: string[] } | ReadyApp;

// The GitHub App counts as configured as soon as any of its variables is set. From then on a missing id or key
// stops repository access instead of falling back to GITHUB_TOKEN.
export function appConfig(): AppConfig {
  if (!GITHUB_APP_VARIABLES.some((name) => process.env[name])) return { state: "absent" };
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    return { state: "incomplete", missing: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"].filter((name) => !process.env[name]) };
  }
  return { state: "ready", appId, privateKey };
}

export const webhookSecret = () => process.env.GITHUB_APP_WEBHOOK_SECRET || undefined;

// GITHUB_API_URL points the module at a stand-in for GitHub in tests. Leave it unset on a real deployment.
export const githubApiUrl = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
