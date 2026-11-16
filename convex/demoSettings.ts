import { accessEnforced } from "./access";

declare const process: { env: Record<string, string | undefined> };

// Variables that belong to the single-owner demo, or to tests, and that do damage if someone sets them on a
// production deployment by mistake. release/backend-env.mjs marks each "never" for production and the release check
// stops on it; these readers make the code refuse them too, the way devToolsEnabled() does in convex/access.ts.
//
// - demoOnly: GITHUB_TOKEN (one token every account would act through), KEIKI_OWNER_CONTACT (every account's notices
//   texted to one number), REVYL_BOOKING_WORKFLOW_ID (every account's verify step running the demo's device
//   workflow on the operator's credits). With accounts on they read as not set.
// - standInOnly: AUTH_STAND_IN_URL (that server would decide who is signed in) and EXPO_PUSH_API_URL (every phone's
//   token sent to that server). Tests and local proofs run with accounts on against stand-ins, so with accounts on
//   they are honoured only when this backend runs on this machine, and never otherwise.

/** True when this deployment is a local backend (npx convex dev --local), decided by its own address the way
 * convex/evidence/localProof.ts decides it. A hosted deployment's address is never localhost. */
export function localBackend(): boolean {
  let host: string;
  try {
    host = new URL(process.env.CONVEX_CLOUD_URL ?? "https://invalid.example").hostname;
  } catch {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

/** The value of a demo-only variable: as set in the single-owner demo, not set with accounts on. */
export function demoOnly(value: string | undefined): string | undefined {
  return accessEnforced() ? undefined : value;
}

/** The value of a stand-in address: as set in the demo, and with accounts on only on a local backend. */
export function standInOnly(value: string | undefined): string | undefined {
  return accessEnforced() && !localBackend() ? undefined : value;
}
