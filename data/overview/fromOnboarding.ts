import type { Onboarding } from "../onboarding/types";
import type { Overview, WatchedCheck } from "./types";

// The example build has no journeys table: what it watches is what its preparation registered.
// Type-only imports, so tests load it as it is.

const settled = ["registered", "nothing_to_add", "unsupported"];

export function overviewFromOnboarding(onboarding: Onboarding | null, map: Overview["map"]): Overview {
  const checks: WatchedCheck[] = (onboarding?.checks ?? []).flatMap((check) => check.kind === "recovery_hook" ? [] : [{
    id: check.kind + ":" + check.url,
    kind: check.kind,
    name: check.name,
    state: check.state === "works" ? "passing" as const : "failing" as const,
    ...(check.state === "works" && { lastPassedAt: check.checkedAt }),
  }]);
  return { checks, preparation: !onboarding ? "none" : settled.includes(onboarding.stage) ? "done" : "in_progress", map };
}
