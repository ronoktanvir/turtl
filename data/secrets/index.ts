import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

// A project's control token and an account's coding agent: from the backend in a live build, hidden in the example build.
export type { CodingAgentStatus, ControlTokenStatus } from "./types";

export const useControlToken = isLiveData ? live.useControlToken : example.useControlToken;
export const saveControlToken = isLiveData ? live.saveControlToken : example.saveControlToken;
export const removeControlToken = isLiveData ? live.removeControlToken : example.removeControlToken;
export const useCodingAgent = isLiveData ? live.useCodingAgent : example.useCodingAgent;
export const saveCodingAgentKey = isLiveData ? live.saveCodingAgentKey : example.saveCodingAgentKey;
export const removeCodingAgentKey = isLiveData ? live.removeCodingAgentKey : example.removeCodingAgentKey;
