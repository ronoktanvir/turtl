import type { CaseSummary } from "../../data/types";
import type { TokenName } from "../../theme/tokens";

// The status word, its colour and its turtle for one card on the Fix or Features list. A feature request is
// something customers asked for: it is a "request", never an "issue", and it is never urgent the way a bug is.

export type IssueTurtle = "affected" | "needs_you" | "working" | "clear" | "review" | "new";
export type IssueState = { label: string; color: TokenName; turtle: IssueTurtle };

export function issueState(item: Pick<CaseSummary, "type" | "status" | "health">): IssueState {
  if (item.status === "resolved") return { label: "Resolved", color: "statusClear", turtle: "clear" };
  if (item.status === "declined") return { label: "Declined", color: "textMuted", turtle: "needs_you" };
  if (item.status === "unresolved") return { label: "Unresolved", color: "statusAffected", turtle: "affected" };
  // The app gives turtl's checks no answer: as urgent as a broken app, and not something turtl is working on.
  if (item.status === "not_answering") return { label: "Not answering", color: "statusAffected", turtle: "affected" };
  if (item.health === "affected" && item.type === "fix") return { label: "Urgent issue", color: "statusAffected", turtle: "affected" };
  if (item.status === "needs_approval" || item.status === "ready_to_merge") return { label: "Needs review", color: "statusReview", turtle: "review" };
  if (item.status === "new") return { label: item.type === "feature" ? "New request" : "New issue", color: "statusNew", turtle: "new" };
  return { label: "Currently working", color: "statusWorking", turtle: "working" };
}

/**
 * The issue "Swipe up to begin review" opens: the first on the list with something to review. A case about an app that
 * is not answering has nothing to review (no fix, nothing to approve), open or closed because turtl stopped checking,
 * so with only that on the list there is no swipe at all: its card opens it.
 */
export function firstToReview(items: Pick<CaseSummary, "id" | "status" | "notAnswering">[]): string | undefined {
  return items.find((item) => item.status !== "not_answering" && !item.notAnswering)?.id;
}
