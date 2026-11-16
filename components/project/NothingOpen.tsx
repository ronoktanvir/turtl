import { useRouter, type Href } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CaseType } from "../../data/types";
import { labels } from "../../theme";
import { Icon, Screen, T, Turtle } from "../ui";
import Watching from "./Watching";

// The Fix or Features list with nothing in it. Same header as BeginScreen, then what turtl is watching meanwhile.

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

export default function NothingOpen({ type, projectId }: { type: CaseType; projectId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const w = words[type];
  return (
    <Screen testID={`begin-${type}`}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to project" testID="header-back" onPress={() => router.canGoBack() ? router.back() : router.replace(`/project/${projectId}` as Href)} style={{ marginLeft: 12, marginTop: 4, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Icon name="ArrowLeft" color="textMuted" />
      </Pressable>
      <T variant="heading" accessibilityRole="header" style={{ textAlign: "center", marginTop: 8, marginBottom: 16 }}>{w.title}</T>
      <ScrollView testID={`begin-${type}-empty`} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32, gap: 28 }}>
        <View style={{ alignItems: "center", gap: 12 }}>
          <Turtle health="clear" size={96} />
          <T variant="strong" color="textMuted">{w.empty}</T>
          <T variant="small" color="textMuted" style={{ textAlign: "center", maxWidth: 320 }}>{w.note}</T>
        </View>
        <Watching projectId={projectId} testID={`begin-${type}-watching`} />
      </ScrollView>
    </Screen>
  );
}
