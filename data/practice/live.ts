import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient, useLiveQuery } from "../live/client";
import type { Practice, PracticeFailure } from "./types";

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

// Practice projects exist only with accounts on, so no owner passcode is ever asked for here.

export function usePractice(): Practice | undefined {
  return useLiveQuery(api.practice.projects.status, {});
}

export async function createPractice(): Promise<{ projectId: string }> {
  return await readable(() => requireLiveClient().action(api.practice.projects.create, {}));
}

export async function breakPractice(projectId: string, failure: PracticeFailure): Promise<void> {
  await readable(() => requireLiveClient().mutation(api.practice.projects.breakApp, { projectId, failure }));
}

export async function mendPractice(projectId: string): Promise<void> {
  await readable(() => requireLiveClient().mutation(api.practice.projects.mend, { projectId }));
}
