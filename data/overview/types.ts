// What turtl is watching on one project, for the screens a project shows before anything has gone wrong.
// The live shape is convex/screens/overview.ts (forProject).

export type WatchedCheck = {
  id: string;
  kind: "journey" | "health" | "readiness" | "flag";
  name: string;
  state: "passing" | "failing" | "waiting"; // waiting: registered, not checked yet
  lastPassedAt?: number;
  closedAs?: "declined" | "unresolved"; // failing with no issue open: how its last issue ended
  // Its last `tries` tries in a row, the first at `since`, got no usable answer from the app; its state is then failing.
  // notReady: the latest was a readiness check's own word that the app cannot serve customers now.
  notAnswering?: { since: number; tries: number; notReady?: boolean };
};

export type Overview = {
  checks: WatchedCheck[];
  // in_progress: the checks arrive once the preparation is merged. unreadable: turtl could not read the repository.
  preparation: "none" | "in_progress" | "done" | "unreadable";
  map: { parts: number; groups: number } | null; // the map of the code the Investigate screen shows
};
