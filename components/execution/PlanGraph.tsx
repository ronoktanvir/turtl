import { useState } from "react";
import { Pressable, View } from "react-native";
import type { PlanStep, PullRequest } from "../../data/types";
import { useTheme, type TokenName } from "../../theme";
import { Icon, Reveal, T, type IconName } from "../ui";
import { AgentRuns } from "./AgentRuns";
import { formatDuration, formatStart } from "./timing";

const status: Record<PlanStep["status"], { label: string; color: TokenName; icon: IconName }> = {
  pending: { label: "Waiting", color: "textMuted", icon: "GitBranch" },
  running: { label: "Working now", color: "statusWorking", icon: "Sparkles" },
  done: { label: "Done", color: "statusClear", icon: "Check" },
  failed: { label: "Stopped", color: "statusNeedsYou", icon: "TriangleAlert" },
  skipped: { label: "Skipped", color: "textMuted", icon: "ArrowDown" },
};

export function PlanGraph({ steps, pullRequest, now }: { steps: PlanStep[]; pullRequest?: PullRequest; now: number }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  return (
    <View testID="enacting-plan-graph">
      {steps.map((step, index) => {
        const look = status[step.status];
        const open = expanded === step.key;
        const checks = step.key === "checks" ? pullRequest?.checkRuns : undefined;
        const timing = step.startedAt !== undefined
          ? `Started ${formatStart(step.startedAt)}` + (
            step.finishedAt !== undefined
              ? ` · took ${formatDuration(step.finishedAt - step.startedAt)}`
              : step.status === "running" ? ` · ${formatDuration(now - step.startedAt)} elapsed` : ""
          )
          : step.status === "skipped" ? "Not run"
            : step.estimatedDurationMs !== undefined ? `About ${formatDuration(step.estimatedDurationMs)}` : "Estimate pending";
        return (
          <View key={step.key}>
            {index > 0 && (
              <View style={{ height: 28, alignItems: "center", justifyContent: "flex-end" }}>
                <View style={{ position: "absolute", top: 0, bottom: 8, width: 1, backgroundColor: colors.border }} />
                <Icon name="ArrowDown" size={16} color="textMuted" />
              </View>
            )}
            <Reveal replayKey={step.status}>
            <Pressable
              onPress={() => setExpanded(open ? null : step.key)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              testID={"plan-step-" + step.key}
              style={({ pressed }) => ({
                padding: 16,
                borderRadius: 20,
                borderWidth: 1,
                borderColor: step.status === "running" ? colors.statusWorking : colors.border,
                backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
                gap: 12,
              })}
            >
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
                  <Icon name={look.icon} color={look.color} size={18} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="strong">{step.title}</T>
                  <T variant="small" color={look.color} testID={"plan-step-status-" + step.key}>{look.label}</T>
                </View>
                <T variant="mono" color="textMuted">{String(index + 1).padStart(2, "0")}</T>
                <Icon name={open ? "ChevronDown" : "ChevronRight"} color="textMuted" size={16} />
              </View>
              <T variant="small" color="textMuted" testID={"plan-timing-" + step.key}>{timing}</T>
              {open && (
                <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
                  {step.summary && <T>{step.summary}</T>}
                  <T color="textMuted">{step.detail ?? (step.summary ? "No further details for this step." : "Details will appear as this step progresses.")}</T>
                  {!!step.agents?.length && <AgentRuns runs={step.agents} testID={"plan-agents-" + step.key} />}
                </View>
              )}
            </Pressable>
            </Reveal>
            {!!checks?.length && (
              <View testID="plan-check-lanes">
                <View style={{ width: 1, height: 16, alignSelf: "center", backgroundColor: colors.border }} />
                <View style={{ padding: 12, gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 20, backgroundColor: colors.surface }}>
                  <T variant="small" color="textMuted">Checks run together</T>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  {checks.slice(0, 2).map((run) => {
                    const tone = run.status === "passed" ? "statusClear" : run.status === "failed" ? "statusAffected" : "textMuted";
                    const checkOpen = openCheck === run.name;
                    return (
                      <Reveal key={run.name} replayKey={run.status} style={{ flex: 1 }}>
                        <Pressable
                          onPress={() => setOpenCheck(checkOpen ? null : run.name)}
                          testID={"plan-check-" + run.name.toLowerCase().replace(/[^a-z]+/g, "-")}
                          accessibilityRole="button"
                          accessibilityState={{ expanded: checkOpen }}
                          style={({ pressed }) => ({ flex: 1, padding: 14, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: pressed ? colors.surfaceRaised : colors.bg })}
                        >
                          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                            <Icon name={run.status === "passed" ? "ShieldCheck" : run.status === "failed" ? "TriangleAlert" : "Terminal"} size={18} color={tone} />
                            <Icon name={checkOpen ? "ChevronDown" : "ChevronRight"} size={14} color="textMuted" />
                          </View>
                          <T variant="strong">{run.name}</T>
                          <T variant="small" color={tone}>{run.status === "passed" ? "Passed" : run.status === "failed" ? "Failed" : "Pending"}</T>
                          {checkOpen && <T variant="small" color="textMuted">{run.status === "passed" ? "Passed on commit " : run.status === "failed" ? "Failed on commit " : "Awaiting a result for commit "}{pullRequest?.headSha.slice(0, 7)}</T>}
                        </Pressable>
                      </Reveal>
                    );
                  })}
                </View>
                {checks.slice(2).map((run) => {
                  const checkOpen = openCheck === run.name;
                  const tone = run.status === "passed" ? "statusClear" : run.status === "failed" ? "statusAffected" : "textMuted";
                  return (
                    <Reveal key={run.name} replayKey={run.status}>
                      <Pressable
                        onPress={() => setOpenCheck(checkOpen ? null : run.name)}
                        testID={"plan-check-" + run.name.toLowerCase().replace(/[^a-z]+/g, "-")}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: checkOpen }}
                        style={({ pressed }) => ({ padding: 14, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: pressed ? colors.surfaceRaised : colors.bg })}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                          <Icon name={run.status === "passed" ? "ShieldCheck" : run.status === "failed" ? "TriangleAlert" : "Terminal"} size={18} color={tone} />
                          <T variant="strong" style={{ flex: 1 }}>{run.name}</T>
                          <Icon name={checkOpen ? "ChevronDown" : "ChevronRight"} size={14} color="textMuted" />
                        </View>
                        <T variant="small" color={tone}>{run.status === "passed" ? "Passed" : run.status === "failed" ? "Failed" : "Pending"}</T>
                        {checkOpen && <T variant="small" color="textMuted">{"Evidence for commit " + pullRequest?.headSha.slice(0, 7) + ". This check runs alongside Typecheck and Tests."}</T>}
                      </Pressable>
                    </Reveal>
                  );
                })}
                </View>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
