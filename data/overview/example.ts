import { useMemo } from "react";
import { getNetwork } from "../example/store";
import { useOnboarding } from "../onboarding/example";
import { overviewFromOnboarding } from "./fromOnboarding";
import type { Overview } from "./types";

export function useOverview(projectId: string): Overview | null | undefined {
  const onboarding = useOnboarding(projectId);
  return useMemo(() => {
    const network = getNetwork(projectId);
    return overviewFromOnboarding(onboarding ?? null, network?.nodes.length ? { parts: network.nodes.length, groups: network.clusters.length } : null);
  }, [onboarding, projectId]);
}
