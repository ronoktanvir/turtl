// What the app knows about the owner's AI permission and spend. The backend's answer, in the shape the screens use.
// See convex/consent/README.md and convex/spend/README.md.

export type AiServiceId = "openai" | "supermemory" | "capy";

export type AiService = {
  id: string;
  name: string;
  does: string;
  receives: string[];
  policy: string;
  /** Whether turtl may send to it now. */
  allowed: boolean;
};

export type AiPermission = {
  /** False in the single-owner demo and the example build: nothing is shown and nothing is blocked. */
  enforced: boolean;
  signedIn: boolean;
  answer: "none" | "allowed" | "declined" | "withdrawn";
  answeredAt?: number;
  withdrawnAt?: number;
  /** True when the permission screen should be shown: never answered, or the list changed since. */
  needsAnswer: boolean;
  listVersion: string;
  services: AiService[];
  alsoUsed: { id: string; name: string; does: string }[];
};

export type AiSpend = {
  enforced: boolean;
  signedIn: boolean;
  month: string;
  spentUsd: number;
  limitUsd: number;
  threadsToday: number;
  threadsPerDay: number;
};

export type AiConsentData = {
  /** undefined while loading; null when the backend cannot say (then nothing is shown). */
  useAiPermission: () => AiPermission | null | undefined;
  useAiSpend: () => AiSpend | null | undefined;
  allowAi: (listVersion: string) => Promise<void>;
  declineAi: (listVersion: string) => Promise<void>;
  withdrawAi: () => Promise<void>;
};
