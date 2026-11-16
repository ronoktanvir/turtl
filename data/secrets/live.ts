import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient, useLiveQuery } from "../live/client";
import type { CodingAgentStatus, ControlTokenStatus } from "./types";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

// A secret only ever travels from this device to the backend. Nothing here reads one back: the backend answers only
// whether it is set and when. Both exist only with accounts on, so no owner passcode is asked for.

export function useControlToken(projectId: string, enabled = true): ControlTokenStatus | null | undefined {
  return useLiveQuery(api.secrets.project.controlToken, enabled && projectId ? { projectId } : "skip");
}

export async function saveControlToken(projectId: string, token: string): Promise<void> {
  await readable(() => requireLiveClient().action(api.secrets.project.setControlToken, { projectId, token }));
}

export async function removeControlToken(projectId: string): Promise<void> {
  await readable(() => requireLiveClient().mutation(api.secrets.project.removeControlToken, { projectId }));
}

export function useCodingAgent(enabled = true): CodingAgentStatus | undefined {
  return useLiveQuery(api.secrets.account.codingAgent, enabled ? {} : "skip");
}

export async function saveCodingAgentKey(apiKey: string): Promise<void> {
  await readable(() => requireLiveClient().action(api.secrets.account.setCodingAgentKey, { apiKey }));
}

export async function removeCodingAgentKey(): Promise<void> {
  await readable(() => requireLiveClient().mutation(api.secrets.account.removeCodingAgentKey, {}));
}
