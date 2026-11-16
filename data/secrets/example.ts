import type { CodingAgentStatus, ControlTokenStatus } from "./types";

// The example data has no backend and no accounts, so it keeps no secrets: the control token and coding agent rows
// stay hidden, exactly as in the single-owner demo, where the backend holds its own.
const DEMO_TOKEN: ControlTokenStatus = { accounts: false, set: false };
const DEMO_AGENT: CodingAgentStatus = { accounts: false, signedIn: true, set: false };
const unavailable = () => Promise.reject(new Error("Keeping a secret needs a turtl backend with accounts. The example data has none."));

export const useControlToken = (_projectId: string, _enabled = true): ControlTokenStatus | null | undefined => DEMO_TOKEN;
export const saveControlToken = (_projectId: string, _token: string): Promise<void> => unavailable();
export const removeControlToken = (_projectId: string): Promise<void> => unavailable();
export const useCodingAgent = (_enabled = true): CodingAgentStatus | undefined => DEMO_AGENT;
export const saveCodingAgentKey = (_apiKey: string): Promise<void> => unavailable();
export const removeCodingAgentKey = (): Promise<void> => unavailable();
