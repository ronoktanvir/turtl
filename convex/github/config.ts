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
// GitHub's pages (installing the app, authorizing it) and its token exchange live on github.com, not on the API's
// host. The stand-in serves both, so GITHUB_API_URL moves both.
export const githubWebUrl = () => (process.env.GITHUB_API_URL ? githubApiUrl() : "https://github.com");

export const SETUP_PATH = "/github/setup";
export const CALLBACK_PATH = "/github/callback";

export type ConnectConfig =
  | { ok: true; app: ReadyApp; slug: string; clientId: string; clientSecret: string; site: string }
  | { ok: false; missing: string[] };

// Connect GitHub needs the app (to read installations and uninstall them), its slug (the install page), its client
// id and secret (the person's authorization, which proves who came back from GitHub), and the deployment's HTTP
// address (where GitHub sends the person back). The client id and secret are the same pair Sign in with GitHub uses.
export function connectConfig(): ConnectConfig {
  const app = appConfig();
  const slug = process.env.GITHUB_APP_SLUG;
  const clientId = process.env.AUTH_GITHUB_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET;
  const site = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
  if (app.state === "ready" && slug && clientId && clientSecret && site) return { ok: true, app, slug, clientId, clientSecret, site };
  const missing = [
    ...(app.state === "incomplete" ? app.missing : app.state === "absent" ? ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] : []),
    ...(slug ? [] : ["GITHUB_APP_SLUG"]),
    ...(clientId ? [] : ["AUTH_GITHUB_ID"]),
    ...(clientSecret ? [] : ["AUTH_GITHUB_SECRET"]),
    ...(site ? [] : ["CONVEX_SITE_URL"]),
  ];
  return { ok: false, missing };
}

// Where GitHub's last redirect sends the person, decided when they start and never read from a request GitHub
// forwards. The app's own scheme opens the Add project screen; on the web only this computer's own addresses are
// accepted, because a ticket sent anywhere else could be used by whoever started the attempt. A hosted web build
// would add its origin here.
export const APP_RETURN = "turtl://add-project";
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;

export function returnAddress(returnTo: string): string | null {
  if (returnTo === "app") return APP_RETURN;
  return LOOPBACK.test(returnTo) ? `${returnTo}/add-project` : null;
}

// The installation's own settings page on GitHub, where the owner chooses which repositories it covers.
export function installationSettingsUrl(installationId: number, accountLogin: string, accountType: string | undefined): string {
  return accountType === "Organization"
    ? `${githubWebUrl()}/organizations/${accountLogin}/settings/installations/${installationId}`
    : `${githubWebUrl()}/settings/installations/${installationId}`;
}
