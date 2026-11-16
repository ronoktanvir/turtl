import type { GithubDisconnect, GithubRefresh, GithubRepository, GithubStatus } from "./types";

// The example data has no backend, so it cannot connect GitHub: Add project stays a typed repository address and
// the gear sheet shows no GitHub row, exactly as before Connect GitHub existed.
const NOT_CONNECTED: GithubStatus = { configured: false, accounts: false, signedIn: true, connections: [] };
const NONE: GithubRepository[] = [];
const unavailable = () => Promise.reject(new Error("Connecting GitHub needs a turtl backend. The example data has none."));

export const useGithubStatus = (_enabled = true): GithubStatus | undefined => NOT_CONNECTED;
export const useGithubRepositories = (_enabled = true): GithubRepository[] | undefined => NONE;
export const beginGithubConnect = (_start: "install" | "authorize" = "install"): Promise<string> => unavailable();
export const finishGithubConnect = (_ticket: string): Promise<{ connected: number; githubLogin: string }> => unavailable();
export const refreshGithubRepositories = (): Promise<GithubRefresh> => unavailable();
export const disconnectGithub = (_accounts: boolean): Promise<GithubDisconnect> => unavailable();
