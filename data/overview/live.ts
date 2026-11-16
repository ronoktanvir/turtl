import { api } from "../../convex/_generated/api";
import { useLiveQuery } from "../live/client";
import type { Overview } from "./types";

export function useOverview(projectId: string): Overview | null | undefined {
  return useLiveQuery(api.screens.overview.forProject, projectId ? { projectId } : "skip");
}
