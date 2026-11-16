import { Platform } from "react-native";
import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient, useLiveQuery } from "../live/client";
import { withOwnerPasscode } from "../live/ownerPasscode";
import type { GithubDisconnect, GithubRefresh, GithubRepository, GithubStatus } from "./types";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

export function useGithubStatus(enabled = true): GithubStatus | undefined {
  return useLiveQuery(api.github.connect.status, enabled ? {} : "skip");
}

export function useGithubRepositories(enabled = true): GithubRepository[] | undefined {
  return useLiveQuery(api.github.connect.repositories, enabled ? {} : "skip");
}

// GitHub's install page (or, for an installation that already exists, its authorize page), carrying a state for this
// attempt. GitHub's last redirect comes back to the app's own scheme, or on the web to this page's origin.
export async function beginGithubConnect(start: "install" | "authorize" = "install"): Promise<string> {
  const returnTo = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "app";
  const { url } = await readable(() => requireLiveClient().action(api.github.connect.begin, { returnTo, ...(start === "authorize" && { start }) }));
  return url;
}

export async function finishGithubConnect(ticket: string): Promise<{ connected: number; githubLogin: string }> {
  return await readable(() => requireLiveClient().mutation(api.github.connect.finish, { ticket }));
}

export async function refreshGithubRepositories(): Promise<GithubRefresh> {
  return await readable(() => requireLiveClient().action(api.github.connect.refresh, {}));
}

// In the single-owner demo, disconnecting is an owner decision behind the owner passcode. With accounts on, the
// signed-in account decides and no passcode is asked.
export async function disconnectGithub(accounts: boolean): Promise<GithubDisconnect> {
  const run = (passcode?: string) => readable(() => requireLiveClient().action(api.github.connect.disconnect, passcode !== undefined ? { passcode } : {}));
  return accounts ? await run() : await readable(() => withOwnerPasscode(run));
}
