import { accessEnforced } from "./access";

declare const process: { env: Record<string, string | undefined> };

// Variables that belong to the single-owner demo, or to tests, and that do damage if someone sets them on a
// production deployment by mistake. release/backend-env.mjs marks each "never" for production and the release check
// stops on it; these readers make the code refuse them too, the way devToolsEnabled() does in convex/access.ts.
//
// - demoOnly: GITHUB_TOKEN (one token every account would act through), KEIKI_OWNER_CONTACT (every account's notices
//   texted to one number), REVYL_BOOKING_WORKFLOW_ID (every account's verify step running the demo's device
//   workflow on the operator's credits). With accounts on they read as not set.
// - standInOnly: AUTH_STAND_IN_URL (that server would decide who is signed in), EXPO_PUSH_API_URL (every phone's
//   token sent to that server), SUPERMEMORY_BASE_URL (every owner's memory, reports and code sent to that server),
//   and KEIKI_BASE_URL and REVYL_BASE_URL (the operator's Keiki and Revyl keys sent to that server).
//   Tests and local proofs run with accounts on against stand-ins on this machine, so with accounts on they are
//   honoured only when this backend runs on this machine and the stand-in does too, and never otherwise.
//
// "This backend runs on this machine" is read from its own address, CONVEX_CLOUD_URL, which Convex sets. On Convex's
// hosted service it is https://<deployment>.convex.cloud, never localhost. A self-hosted Convex backend left on its
// default address (http://127.0.0.1:3210) would read as local, so a stand-in must also be on this machine: a
// deployment mistaken for a local one can then be pointed only at a service on its own host, never at another server.

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

function onThisMachine(address: string | undefined): boolean {
  try {
    return LOOPBACK.includes(new URL(address ?? "https://invalid.example").hostname);
  } catch {
    return false;
  }
}

/** True when this deployment is a local backend (npx convex dev --local), decided by its own address the way
 * convex/evidence/localProof.ts decides it. A deployment on Convex's hosted service is never localhost. */
export function localBackend(): boolean {
  return onThisMachine(process.env.CONVEX_CLOUD_URL);
}

/** The value of a demo-only variable: as set in the single-owner demo, not set with accounts on. */
export function demoOnly(value: string | undefined): string | undefined {
  return accessEnforced() ? undefined : value;
}

/** The value of a stand-in address: as set in the demo, and with accounts on only on a local backend, for a stand-in
 * on this machine. */
export function standInOnly(value: string | undefined): string | undefined {
  return accessEnforced() && !(localBackend() && onThisMachine(value)) ? undefined : value;
}
