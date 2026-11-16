// What turtl is watching on one project, for the screens a project shows before anything has gone wrong.
// The live shape is convex/screens/overview.ts (forProject).

export type WatchedCheck = {
  id: string;
  kind: "journey" | "health" | "readiness" | "flag";
  name: string;
  state: "passing" | "failing" | "waiting"; // waiting: registered, not checked yet
  lastPassedAt?: number;
};

export type Overview = {
  checks: WatchedCheck[];
  preparation: "none" | "in_progress" | "done"; // in_progress: the checks arrive once the preparation is merged
  map: { parts: number; groups: number } | null; // the map of the code the Investigate screen shows
};
