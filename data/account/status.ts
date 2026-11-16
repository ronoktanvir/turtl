import { words } from "../../convex/auth/rules";
import type { AccountMode, AccountStatus } from "./types";

// The decisions behind the sign-in gate, kept free of React so tests can read them.

export function accountStatus({ live, storeBuild, mode, auth }: {
  live: boolean;
  storeBuild: boolean;
  mode: AccountMode | undefined;
  auth: { isLoading: boolean; isAuthenticated: boolean };
}): AccountStatus {
  if (!live) return "demo";
  if (mode === undefined) return "checking";
  if (!mode.accounts) return storeBuild ? "accountsOff" : "demo";
  if (auth.isLoading) return "checking";
  return auth.isAuthenticated ? "signedIn" : "signedOut";
}

/** The routes someone may see signed out. Everything else needs a session when accounts are on. */
export const SIGNED_OUT_ROUTES = ["", "sign-in", "sign-up", "reset-password"] as const;

/** Where the gate sends someone from the route whose first segment is `first`, or null to leave them there. */
export function gateTarget(status: AccountStatus, first: string | undefined): "/" | "/projects" | null {
  const signedOutRoute = (SIGNED_OUT_ROUTES as readonly string[]).includes(first ?? "");
  if (status === "signedOut" && !signedOutRoute) return "/";
  if (status === "signedIn" && signedOutRoute) return "/projects";
  return null;
}

/** Whether to hide the screens while the answer is unknown: in a store build always, elsewhere once accounts are known to be on. */
export function holdScreens(status: AccountStatus, storeBuild: boolean, mode: AccountMode | undefined): boolean {
  return status === "checking" && (storeBuild || mode?.accounts === true);
}

/** Whether the Login screen's buttons sign in for real, or are the demo's controls that go straight to Home. */
export function realSignIn(storeBuild: boolean, mode: AccountMode | undefined): boolean {
  return storeBuild || mode?.accounts === true;
}

const NETWORK = /network|failed to fetch|load failed|connection|offline|timed? ?out|ECONNREFUSED|socket/i;

/** What to tell the owner when signing in throws. The backend's refusals are already in plain words. */
export function signInMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error && typeof (error as { data: unknown }).data === "string") return (error as { data: string }).data;
  const text = error instanceof Error ? error.message : String(error);
  if (NETWORK.test(text)) return words.offline;
  return words.unknown;
}
