import type { Enactment, FixOption } from "../../data/types";

// Which controls the running-fix screen shows. A control shows only when it can do something or is about to:
// Stop while the fix is still under way, Merge only for a fix that is a pull request and only once there is one.
// A fix that changes a setting has nothing to merge, so it never shows Merge; a finished fix shows no Stop.

export type Controls = {
  stop: boolean;
  merge: "enabled" | "waiting" | null;
  status: string | null; // the line beside them: the pull request's state, or null when there is none to report
};

export function enactmentControls(e: Pick<Enactment, "state" | "pullRequest">, fix: Pick<FixOption, "delivery"> | undefined): Controls {
  const pr = e.pullRequest;
  const stop = e.state === "running" || e.state === "needs_you" || e.state === "waiting_for_merge";
  const pullRequestFix = fix?.delivery === "pull_request";
  const open = pr?.state === "open";
  const merge = !pullRequestFix || !open ? null
    : e.state === "waiting_for_merge" && pr.checks === "passing" && pr.mergeable ? "enabled" : "waiting";
  const passed = pr?.checkRuns.filter((run) => run.status === "passed").length ?? 0;
  const status = !pullRequestFix ? null
    : !pr ? (stop ? "No pull request yet" : null)
      : pr.state === "merged" ? "Merged"
        : pr.state === "closed" ? "Pull request closed"
          : pr.checks === "passing" ? "Checks passed"
            : pr.checks === "failing" ? "Checks failed"
              : pr.checks === "none" ? "No checks reported"
                : "Checks running: " + passed + " of " + pr.checkRuns.length + " passed";
  return { stop, merge, status };
}
