import type { Health } from "../../data/types";
import type { LiveCheck, Onboarding, OnboardingStage, ReadinessStatus } from "../../data/onboarding/types";
import type { TokenName } from "../../theme";

export const editableStages: OnboardingStage[] = ["asking", "ready", "nothing_to_add"];
export const inspectableStages: OnboardingStage[] = ["inspection_failed", "unsupported", "asking", "ready", "nothing_to_add", "opening_failed", "closed"];
export const ownerStages: OnboardingStage[] = ["asking", "ready", "pr_open"];

export function stageLine(o: Onboarding): { line: string; health: Health } {
  const pr = o.pullRequest;
  switch (o.stage) {
    case "inspecting": return { line: "Reading your repository…", health: "working" };
    case "inspection_failed": return { line: "turtl couldn't read this repository", health: "needs_you" };
    case "unsupported": return { line: "Here is what turtl found", health: "clear" };
    case "asking": return { line: "Tell turtl what must never break", health: "needs_you" };
    case "ready": return { line: "Ready to prepare", health: "needs_you" };
    case "nothing_to_add": return { line: "Your app already has everything turtl needs", health: "clear" };
    case "opening": return { line: "Capy is writing the pull request", health: "working" };
    case "opening_failed": return { line: "The pull request could not be opened", health: "needs_you" };
    case "pr_open":
      if (pr?.checks === "passing" && pr.mergeable) return { line: "Ready for you to merge", health: "needs_you" };
      if (pr?.checks === "failing") return { line: "The checks failed", health: "needs_you" };
      return { line: "Waiting for checks", health: "working" };
    case "registering": return { line: "Checking your live app", health: "working" };
    case "registered": return { line: "Here is what works now", health: "clear" };
    case "closed": return { line: "The pull request was closed without merging", health: "needs_you" };
  }
}

export function preparationStatus(o: Onboarding): string {
  if (o.stage === "registered") {
    const works = o.checks.filter((c) => c.state === "works").length;
    return o.checks.length ? works + " of " + o.checks.length + " checks work" : stageLine(o).line;
  }
  const items = o.inspection?.items ?? [];
  if (items.length && (o.stage === "asking" || o.stage === "unsupported" || o.stage === "nothing_to_add")) {
    return items.filter((i) => i.status === "found").length + " of " + items.length + " ready";
  }
  return stageLine(o).line;
}

export const readinessWord: Record<ReadinessStatus, { word: string; color: TokenName }> = {
  found: { word: "Found", color: "statusClear" },
  missing: { word: "Missing", color: "statusNeedsYou" },
  unknown: { word: "Unknown", color: "textMuted" },
};

export const checkKindLabel: Record<LiveCheck["kind"], string> = {
  health: "Health check",
  readiness: "Readiness check",
  journey: "Journey",
  flag: "Feature flag",
  recovery_hook: "Recovery hook",
};

export const checkStateWord: Record<LiveCheck["state"], { word: string; color: TokenName }> = {
  works: { word: "Works", color: "statusClear" },
  failing: { word: "Failing", color: "statusAffected" },
  no_response: { word: "No response", color: "statusNeedsYou" },
};

const RULES_NOTE = "No model answered, so turtl judged this with its built-in rules.";

/** The note above a report judged by rules. The backend's reason already begins "No model answered", so it is not said twice. */
export function rulesNote(fallbackReason: string | undefined): string {
  const reason = fallbackReason?.trim().replace(/^No model answered\s*[:.]?\s*/i, "");
  if (!reason) return RULES_NOTE;
  return RULES_NOTE + " " + reason.charAt(0).toUpperCase() + reason.slice(1);
}
