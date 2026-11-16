import {
  CASE_KINDS,
  CASE_STATUSES,
  type AttemptStatus,
  type CaseKind,
  type CaseStatus,
  type RaisedBy,
  type Stage,
  type StepStatus,
} from "../../convex/constants";

export type CardId =
  | "what-broke"
  | "what-we-found"
  | "recommended-action"
  | "work-in-progress"
  | "proof"
  | "what-we-learned";

export type CardDefinition = {
  id: CardId;
  name: string;
  copy: string;
  purposes: readonly Stage[];
};

// The one place that maps cards to step purposes. Change the mapping here.
export const CARDS: readonly CardDefinition[] = [
  {
    id: "what-broke",
    name: "What broke",
    copy: "Placeholder: a plain-language description of the problem will appear here.",
    purposes: ["detect_or_receive"],
  },
  {
    id: "what-we-found",
    name: "What we found",
    copy: "Placeholder: what the investigation turned up and how sure we are will appear here.",
    purposes: ["collect_app_state", "collect_error_window", "gather_context", "investigate", "examine_broader_causes"],
  },
  {
    id: "recommended-action",
    name: "Recommended action",
    copy: "Placeholder: the proposed fix and what it changes will appear here. Nothing runs from this card.",
    purposes: ["plan"],
  },
  {
    id: "work-in-progress",
    name: "Work in progress",
    copy: "Placeholder: what is being done right now will appear here.",
    purposes: ["authorize_and_execute"],
  },
  {
    id: "proof",
    name: "Proof",
    copy: "Placeholder: evidence that the app works again will appear here.",
    purposes: ["verify"],
  },
  {
    id: "what-we-learned",
    name: "What we learned",
    copy: "Placeholder: what to remember for next time will appear here.",
    purposes: ["learn"],
  },
];

export type FeedStep = {
  _id: string;
  key: string;
  title: string;
  purpose: Stage;
  status: StepStatus;
  currentAttempt: { attempt: number; status: AttemptStatus; summary?: string } | null;
};

export type CardStatus = "pending" | "in_progress" | "waiting" | "done" | "failed";

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
};

export const CARD_STATUS_COLORS: Record<CardStatus, string> = {
  pending: "#8E8E93",
  in_progress: "#0A84FF",
  waiting: "#FF9F0A",
  done: "#30A46C",
  failed: "#E5484D",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export const STEP_STATUS_COLORS: Record<StepStatus, string> = {
  pending: CARD_STATUS_COLORS.pending,
  running: CARD_STATUS_COLORS.in_progress,
  waiting: CARD_STATUS_COLORS.waiting,
  done: CARD_STATUS_COLORS.done,
  failed: CARD_STATUS_COLORS.failed,
  skipped: CARD_STATUS_COLORS.pending,
};

export const CASE_STATUS_LABELS = Object.fromEntries(
  CASE_STATUSES.map((status) => [status.id, status.label]),
) as Record<CaseStatus, string>;

const RESTORED_COLOR = "#12A594";

export const CASE_STATUS_COLORS: Record<CaseStatus, string> = {
  open: CARD_STATUS_COLORS.in_progress,
  // Placeholder (not-answering cases, backend half): the screens decide this case's colour.
  waiting_for_app: CARD_STATUS_COLORS.failed,
  investigating: CARD_STATUS_COLORS.in_progress,
  waiting_for_owner: CARD_STATUS_COLORS.waiting,
  executing: CARD_STATUS_COLORS.in_progress,
  waiting_for_deploy: CARD_STATUS_COLORS.waiting,
  verifying: CARD_STATUS_COLORS.in_progress,
  restored: RESTORED_COLOR,
  resolved: CARD_STATUS_COLORS.done,
  unresolved: CARD_STATUS_COLORS.failed,
  declined: CARD_STATUS_COLORS.pending,
};

export const RAISED_BY_LABELS: Record<RaisedBy, string> = {
  monitor: "Monitor",
  owner: "Owner",
  customer: "Customer",
};

export function kindLabel(kind: CaseKind) {
  return CASE_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

export function cardStatus(steps: readonly FeedStep[]): CardStatus {
  if (steps.length === 0) return "pending";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.every((s) => s.status === "done" || s.status === "skipped")) return "done";
  if (steps.every((s) => s.status === "pending")) return "pending";
  if (steps.some((s) => s.status === "waiting") && !steps.some((s) => s.status === "running")) {
    return "waiting";
  }
  return "in_progress";
}

export function buildCards(steps: readonly FeedStep[]) {
  return CARDS.map((card) => {
    const cardSteps = steps.filter((s) => card.purposes.includes(s.purpose));
    return { ...card, steps: cardSteps, status: cardStatus(cardSteps) };
  });
}

export function timeAgo(from: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
