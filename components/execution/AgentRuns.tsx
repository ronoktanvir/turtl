import { View } from "react-native";
import { formatAgentCost, formatAgentDuration } from "../../data";
import type { AgentRunView } from "../../data/types";
import { useTheme, type TokenName } from "../../theme";
import { Icon, T } from "../ui";

const outcomes: Record<NonNullable<AgentRunView["outcome"]>, { word: string; tone: TokenName }> = {
  verified: { word: "Verified by the fix's check", tone: "statusClear" },
  corrected: { word: "Corrected by you", tone: "statusNeedsYou" },
  failed: { word: "Did not establish the cause", tone: "statusNeedsYou" },
  infra_failure: { word: "Service failure, not counted", tone: "textMuted" },
};

// Who worked on a step and why: the configuration, the reason it was chosen, any handoff, cost and duration. Plain
// views, because the plan node around them is already a button.
export function AgentRuns({ runs, testID }: { runs: AgentRunView[]; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 10 }} testID={testID}>
      <T variant="small" color="textMuted">Who worked on this</T>
      {runs.map((run) => {
        const outcome = run.outcome && outcomes[run.outcome];
        return (
          <View key={run.id} testID={"agent-run-" + run.id} style={{ padding: 12, gap: 6, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name={run.task === "diagnosis" ? "Sparkles" : "Users"} size={16} color={run.status === "failed" ? "statusNeedsYou" : "brandDeep"} />
              <T variant="strong" style={{ flex: 1 }}>{run.configuration}</T>
              <T variant="small" color="textMuted">{formatAgentCost(run.costUsd) + " · " + formatAgentDuration(run.durationMs)}</T>
            </View>
            <T variant="small" color="textMuted">{run.model}</T>
            {run.handedUpFrom && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Icon name="ArrowUp" size={14} color="statusWorking" />
                <T variant="small" color="statusWorking">{"Took over from the " + run.handedUpFrom.toLowerCase()}</T>
              </View>
            )}
            {run.handedUpTo && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Icon name="ArrowUp" size={14} color="statusWorking" />
                <T variant="small" color="statusWorking">{"Handed its evidence up to the " + run.handedUpTo.toLowerCase()}</T>
              </View>
            )}
            {outcome && <T variant="small" color={outcome.tone}>{outcome.word}</T>}
            <View style={{ gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
              <T variant="small">{"Why: " + run.reason}</T>
              {run.error && <T variant="small" font="text" color="statusNeedsYou">{run.error}</T>}
              {!run.outcome && run.outcomeReason && <T variant="small" color="textMuted">{run.outcomeReason}</T>}
            </View>
          </View>
        );
      })}
    </View>
  );
}
