import { isLiveData } from "../source";
import { example } from "./example";
import { live } from "./live";

// The AI permission and spend, from the backend in a live build and from memory in the example build.
const source = isLiveData ? live : example;

export const useAiPermission = source.useAiPermission;
export const useAiSpend = source.useAiSpend;
export const allowAi = source.allowAi;
export const declineAi = source.declineAi;
export const withdrawAi = source.withdrawAi;
export type { AiPermission, AiService, AiServiceId, AiSpend } from "./types";
