import { useMemo, useSyncExternalStore } from "react";
import { PRACTICE_PROJECT_ID } from "../example/practice";
import { getNetwork, getVersion, subscribe } from "../example/store";
import { useOnboarding } from "../onboarding/example";
import { practiceWatch } from "../practice/example";
import { overviewFromOnboarding } from "./fromOnboarding";
import type { Overview } from "./types";

export function useOverview(projectId: string): Overview | null | undefined {
  const onboarding = useOnboarding(projectId);
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => {
    // The example practice app has no preparation: what turtl watches on it is its booking check.
    const practice = projectId === PRACTICE_PROJECT_ID ? practiceWatch() : null;
    if (practice) {
      return { checks: [{ id: "practice-journey", kind: "journey" as const, name: "Book an appointment", state: practice.failing ? ("failing" as const) : ("passing" as const), lastPassedAt: practice.lastPassedAt }], preparation: "none" as const, map: null };
    }
    const network = getNetwork(projectId);
    return overviewFromOnboarding(onboarding ?? null, network?.nodes.length ? { parts: network.nodes.length, groups: network.clusters.length } : null);
  }, [onboarding, projectId, version]);
}
