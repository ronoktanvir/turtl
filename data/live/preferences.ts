import { makeFunctionReference } from "convex/server";
import type { Preferences } from "../types";
import { liveClient, useLiveQuery } from "./client";

const list = makeFunctionReference<"query", { projectId: string }, Preferences | null>("learning/preferences:list");

export function usePreferences(projectId: string): Preferences | null | undefined {
  const result = useLiveQuery(list, projectId ? { projectId } : "skip");
  if (!liveClient || !projectId) return null;
  return result;
}
