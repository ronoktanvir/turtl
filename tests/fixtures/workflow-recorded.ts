export function recordedWorkflow(scenario = "running") {
  const attempt = (key: string, status: string, number = 1) => ({
    _id: `attempt-${key}-${number}`,
    attempt: number,
    status,
    startedAt: 1794700800000,
    ...(status === "done" || status === "failed" ? { finishedAt: 1794700801200 } : {}),
    inputRefs: key === "gather" ? ["attempt-app-state-2", "attempt-error-window-1"] : ["attempt-detect-1"],
    outputRefs: status === "done" ? [{ kind: "evidence", id: `evidence-${key}`, label: "Recorded evidence reference" }, ...(scenario === "long-refs" ? [{ kind: "evidence", id: "e".repeat(140), label: "Long recorded reference" }] : [])] : [],
    summary: "Local recorded-data fixture; no external collector ran.",
    ...(status === "failed" ? { error: "The recorded collector request failed." } : {}),
  });
  const step = (key: string, title: string, purpose: string, dependsOn: string[], status: "pending" | "running" | "waiting" | "done" | "failed" | "skipped", number = 1) => ({
    _id: `step-${key}`, key, title, purpose, dependsOn, status,
    currentAttempt: status === "pending" || status === "skipped" ? null : attempt(key, status, number),
    ...(status === "skipped" ? { skipReason: "Recorded skip: this step was not needed." } : {}),
  });
  if (scenario === "legacy") return { _id: "local-fixture", steps: [
    step("detect", "Receive report", "detect_or_receive", [], "done"),
    step("gather", "Gather context", "gather_context", ["detect"], "running"),
    step("investigate", "Investigate", "investigate", ["gather"], "pending"),
  ] };
  if (scenario === "malformed") return { _id: "local-fixture", steps: [
    step("missing", "Missing dependency", "gather_context", ["not-recorded"], "waiting"),
    step("a", "Cycle A", "investigate", ["b"], "failed"),
    step("b", "Cycle B", "propose", ["a"], "skipped"),
  ] };
  const collectorsDone = scenario === "joined" || scenario === "skipped" || scenario === "long-refs";
  return { _id: "local-fixture", steps: [
    step("gather", "Gather context", "gather_context", ["app-state", "error-window"], collectorsDone ? "done" : "pending"),
    step("error-window", "Collect error window", "collect_error_window", ["detect"], scenario === "waiting" ? "waiting" : scenario === "failed" ? "failed" : collectorsDone ? "done" : "running"),
    step("detect", "Receive report", "detect_or_receive", [], "done"),
    step("app-state", "Collect application state", "collect_app_state", ["detect"], collectorsDone || scenario === "failed" ? "done" : "running", 2),
    step("investigate", "Investigate evidence", "investigate", ["gather"], scenario === "skipped" ? "skipped" : "pending"),
  ] };
}
