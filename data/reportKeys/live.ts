import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { errorMessage, requireLiveClient, useLiveQuery } from "../live/client";
import { withOwnerPasscode } from "../live/ownerPasscode";
import type { ReportKey } from "./types";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

// In the single-owner demo, making or revoking a key is an owner decision behind the owner passcode. With accounts on,
// the signed-in owner decides and no passcode is asked (withOwnerPasscode knows which).
const owner = <T>(work: (passcode?: string) => Promise<T>) => readable(() => withOwnerPasscode((passcode) => readable(() => work(passcode))));
const passcodeArg = (passcode?: string) => (passcode !== undefined ? { passcode } : {});

export function useReportKeys(projectId: string, enabled = true): ReportKey[] | null | undefined {
  return useLiveQuery(api.intake.keys.forApp, enabled && projectId ? { appId: projectId as Id<"apps"> } : "skip");
}

/** The new key, whole. This is the only time the backend gives it out. */
export async function makeReportKey(projectId: string): Promise<string> {
  const { key } = await owner((passcode) => requireLiveClient().mutation(api.intake.keys.issue, { appId: projectId as Id<"apps">, ...passcodeArg(passcode) }));
  return key;
}

export async function revokeReportKey(keyId: string): Promise<void> {
  await owner((passcode) => requireLiveClient().mutation(api.intake.keys.revoke, { keyId, ...passcodeArg(passcode) }));
}
