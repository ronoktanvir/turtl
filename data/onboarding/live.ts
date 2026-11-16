import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient, useLiveQuery } from "../live/client";
import { withOwnerPasscode } from "../live/ownerPasscode";
import type { NeverBreakAnswer, NewProject, Onboarding } from "./types";

const refusal = "That owner passcode is incorrect. Try again.";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new Error(errorMessage(error)); }
}

const owner = <T>(work: (passcode?: string) => Promise<T>) => readable(() => withOwnerPasscode((passcode) => readable(() => work(passcode))));
const passcodeArg = (passcode?: string) => (passcode !== undefined ? { passcode } : {});

export function useOnboarding(projectId: string): Onboarding | null | undefined {
  return useLiveQuery(api.onboarding.projects.forProject, { projectId }) as Onboarding | null | undefined;
}

export function addProject(input: NewProject): Promise<{ projectId: string }> {
  const liveUrl = input.liveUrl?.trim();
  const folders = input.folders?.filter((folder) => folder.trim());
  return owner((passcode) => requireLiveClient().mutation(api.onboarding.projects.add, {
    repoUrl: input.repoUrl.trim(),
    ...(liveUrl ? { liveUrl } : {}),
    ...(folders?.length ? { folders } : {}),
    ...passcodeArg(passcode),
  }));
}

export async function saveNeverBreak(projectId: string, answers: NeverBreakAnswer[]): Promise<void> {
  await readable(() => requireLiveClient().mutation(api.onboarding.projects.saveAnswers, { projectId, answers }));
}

export async function approvePreparation(projectId: string, inspectionId: string): Promise<void> {
  await owner((passcode) => requireLiveClient().mutation(api.onboarding.projects.approve, { projectId, inspectionId, ...passcodeArg(passcode) }));
}

export async function mergePreparation(projectId: string, headSha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    return await withOwnerPasscode(async (passcode) => {
      const result = await readable(() => requireLiveClient().action(api.onboarding.projects.merge, { projectId, headSha, ...passcodeArg(passcode) }));
      if (!result.ok && result.reason === refusal) throw new Error(result.reason);
      return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason };
    });
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export async function refreshPreparation(projectId: string): Promise<void> {
  await readable(() => requireLiveClient().action(api.onboarding.projects.refresh, { projectId }));
}

export async function inspectAgain(projectId: string): Promise<void> {
  await owner((passcode) => requireLiveClient().mutation(api.onboarding.projects.inspectAgain, { projectId, ...passcodeArg(passcode) }));
}

export async function checkLiveAgain(projectId: string): Promise<void> {
  await owner((passcode) => requireLiveClient().mutation(api.onboarding.projects.checkAgain, { projectId, ...passcodeArg(passcode) }));
}
