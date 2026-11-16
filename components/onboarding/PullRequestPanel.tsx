import { Linking, Pressable, View } from "react-native";
import type { PullRequest } from "../../data/types";
import { useTheme } from "../../theme";
import { Button, Icon, T } from "../ui";

export function ciState(pr: PullRequest): string {
  if (pr.state === "merged") return "Merged";
  if (pr.state === "closed") return "Pull request closed";
  if (pr.checks === "passing") return pr.mergeable ? "Checks passed" : "Checks passed; GitHub can't merge it yet";
  if (pr.checks === "failing") return "Checks failed";
  if (pr.checks === "none") return "No checks reported";
  return "Checks running: " + pr.checkRuns.filter((r) => r.status === "passed").length + " of " + pr.checkRuns.length + " passed";
}

export function canMergePreparation(pr?: PullRequest): boolean {
  return pr?.state === "open" && pr.checks === "passing" && pr.mergeable;
}

export function PullRequestPanel({ pr, merging, refreshing, onMerge, onRefresh }: { pr: PullRequest; merging: boolean; refreshing: boolean; onMerge: () => void; onRefresh: () => void }) {
  const { colors } = useTheme();
  const canMerge = canMergePreparation(pr);
  return (
    <View style={{ gap: 14 }} testID="prepare-pr">
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <T variant="title" accessibilityRole="header">Pull request</T>
        {pr.state === "open" && (
          <Pressable accessibilityRole="button" onPress={onRefresh} disabled={refreshing} testID="prepare-refresh" style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
            <T color="link">{refreshing ? "Refreshing…" : "Refresh"}</T>
          </Pressable>
        )}
      </View>
      <View style={{ gap: 12, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
        <Pressable onPress={() => void Linking.openURL(pr.url)} accessibilityRole="link" testID="prepare-pr-link" style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}>
          <Icon name={pr.state === "merged" ? "GitMerge" : "GitPullRequest"} color="brandDeep" size={22} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="small" color="textMuted">{"#" + pr.number + " on GitHub"}</T>
            <T variant="strong">{pr.title}</T>
          </View>
          <Icon name="ExternalLink" color="textMuted" size={16} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="GitBranch" color="textMuted" size={16} />
          <T variant="small" color="textMuted" style={{ flex: 1 }}>Latest commit</T>
          <T variant="mono" color="textMuted" testID="prepare-pr-head">{pr.headSha}</T>
        </View>
        {pr.checkRuns.map((run) => {
          const color = run.status === "passed" ? "statusClear" : run.status === "failed" ? "statusAffected" : "textMuted";
          return (
            <View key={run.name} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Icon name={run.status === "passed" ? "Check" : run.status === "failed" ? "X" : "Terminal"} size={16} color={color} />
              <T style={{ flex: 1 }}>{run.name}</T>
              <T variant="small" color={color}>{run.status === "passed" ? "Passed" : run.status === "failed" ? "Failed" : "Pending"}</T>
            </View>
          );
        })}
      </View>
      {pr.state === "open" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Button label={merging ? "Merging…" : "Merge"} icon="GitMerge" disabled={!canMerge || merging} onPress={onMerge} testID="prepare-merge" />
          <T variant="small" color={canMerge ? "statusClear" : pr.checks === "failing" ? "statusAffected" : "textMuted"} style={{ flex: 1 }} testID="prepare-ci">{ciState(pr)}</T>
        </View>
      )}
    </View>
  );
}
