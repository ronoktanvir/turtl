import { useRouter, type Href } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProject } from "../../data";
import { useOverview, type WatchedCheck } from "../../data/overview";
import type { CaseType } from "../../data/types";
import { labels } from "../../theme";
import { Icon, Screen, T, Turtle } from "../ui";
import Watching from "./Watching";

// The Fix or Features list with nothing in it. Same header as BeginScreen, then what turtl is watching meanwhile.

// A practice app has no customers, so nothing reaches it from them: its notes say what does happen there.
const practiceNotes: Record<CaseType, string> = {
  fix: "When you break your practice app, turtl's check notices and opens an issue here.",
  feature: "Your practice app has no customers, so no feature requests come here. Your own projects' requests do.",
};

const words: Record<CaseType, { title: string; empty: string; note: string }> = {
  fix: {
    title: "Current issues",
    empty: "Nothing to fix.",
    note: "When a check stops passing or a customer reports a problem, turtl opens an issue here and works out what to do.",
  },
  feature: {
    title: labels.features,
    empty: "No feature requests.",
    note: "When customers ask for something new, turtl gathers their requests here.",
  },
};

/**
 * The empty Fix list when a check is still failing and no issue is open for it, because its last one closed without a
 * fix. It uses the checks panel's own words ("Not passing") and says what the person can do. Null when nothing is.
 */
export function stillBroken(checks: WatchedCheck[] | undefined, practice: boolean): { empty: string; note: string } | null {
  const check = checks?.find((candidate) => candidate.state === "failing" && candidate.closedAs);
  if (!check) return null;
  const why = check.closedAs === "declined" ? "its fixes were declined" : "turtl could not fix it";
  return {
    empty: `${check.name}: not passing.`,
    note: practice
      ? `No issue is open for it, because the last one closed when ${why}. Put it back from the Break it tile on the project.`
      : `No issue is open for it, because the last one closed when ${why}. turtl opens a new one if the check passes and then fails again, and a customer's report opens one too.`,
  };
}

export default function NothingOpen({ type, projectId }: { type: CaseType; projectId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const practice = useProject(projectId)?.practice === true;
  const overview = useOverview(projectId);
  const broken = type === "fix" ? stillBroken(overview?.checks, practice) : null;
  const w = { ...words[type], ...(practice && { note: practiceNotes[type] }), ...broken };
  return (
    <Screen testID={`begin-${type}`}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to project" testID="header-back" onPress={() => router.canGoBack() ? router.back() : router.replace(`/project/${projectId}` as Href)} style={{ marginLeft: 8, marginTop: 4, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Icon name="ArrowLeft" color="textMuted" />
      </Pressable>
      <T variant="heading" accessibilityRole="header" style={{ textAlign: "center", marginTop: 8, marginBottom: 16 }}>{w.title}</T>
      <ScrollView testID={`begin-${type}-empty`} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32, gap: 28 }}>
        <View style={{ alignItems: "center", gap: 12 }}>
          <Turtle health={broken ? "needs_you" : "clear"} size={96} alive />
          <T variant="strong" color={broken ? "statusAffected" : "textMuted"} style={{ textAlign: "center", maxWidth: 320 }} testID={`begin-${type}-empty-line`}>{w.empty}</T>
          <T variant="small" color="textMuted" style={{ textAlign: "center", maxWidth: 320 }}>{w.note}</T>
        </View>
        <Watching projectId={projectId} testID={`begin-${type}-watching`} />
      </ScrollView>
    </Screen>
  );
}
