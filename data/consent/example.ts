import { useSyncExternalStore } from "react";
import { ALSO_USED, ASKED, LIST_VERSION } from "../../convex/consent/services";
import type { AiConsentData, AiPermission, AiSpend } from "./types";

// The example build has no accounts, so it never asks and never blocks: `enforced` is false and every screen
// behaves as it did before the permission existed. The list is the same one the backend reads, so opening
// /ai-permission directly still shows the real services and what each receives.

let answer: AiPermission["answer"] = "none";
let answeredAt: number | undefined;
let version = 0;
const listeners = new Set<() => void>();
const commit = (next: AiPermission["answer"]) => {
  answer = next;
  answeredAt = Date.now();
  version += 1;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function permission(): AiPermission {
  return {
    enforced: false,
    signedIn: true,
    answer,
    ...(answeredAt !== undefined && { answeredAt }),
    needsAnswer: false,
    listVersion: LIST_VERSION,
    services: ASKED.map(({ id, name, does, receives, policy }) => ({ id, name, does, receives, policy, allowed: answer === "allowed" })),
    alsoUsed: ALSO_USED,
  };
}

const spend: AiSpend = { enforced: false, signedIn: true, month: "", spentUsd: 0, limitUsd: 0, threadsToday: 0, threadsPerDay: 0 };

export const example: AiConsentData = {
  useAiPermission: () => {
    useSyncExternalStore(subscribe, () => version, () => version);
    return permission();
  },
  useAiSpend: () => spend,
  allowAi: async () => commit("allowed"),
  declineAi: async () => commit("declined"),
  withdrawAi: async () => commit("withdrawn"),
};
