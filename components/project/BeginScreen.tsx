import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useMemo } from "react";
import { Image, PanResponder, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCases, useProject } from "../../data";
import type { CaseSummary, CaseType } from "../../data/types";
import { labels, useTheme, type TokenName } from "../../theme";
import { Button, Icon, Screen, T, Turtle, ZoomPressable } from "../ui";

function issueState(item: CaseSummary): { label: string; color: TokenName; image: number } {
  if (item.health === "affected") return { label: "Urgent issue", color: "statusAffected", image: require("../../assets/turtle/affected-laptop.png") };
  if (item.status === "needs_approval" || item.status === "ready_to_merge") return { label: "Needs review", color: "statusReview", image: require("../../assets/turtle/review.png") };
  if (item.status === "new") return { label: "New issue", color: "statusNew", image: require("../../assets/turtle/new.png") };
  return { label: "Currently working", color: "statusWorking", image: require("../../assets/turtle/working-laptop.png") };
}

function exactTime(at: number) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

export default function BeginScreen({ type }: { type: CaseType }) {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const cases = useCases(projectId, type);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { colors } = useTheme();
  const firstId = cases?.[0]?.id;
  const openFirst = () => { if (firstId) router.push(`/review/${firstId}` as Href); };
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy < -10 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderRelease: (_, gesture) => { if (gesture.dy < -40 && firstId) router.push(`/review/${firstId}` as Href); },
  }), [firstId, router]);

  return (
    <Screen testID={`begin-${type}`}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to project" testID="header-back" onPress={() => router.canGoBack() ? router.back() : router.replace(`/project/${projectId}` as Href)} style={{ marginLeft: 12, marginTop: 4, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Icon name="ArrowLeft" color="textMuted" />
      </Pressable>
      <T variant="heading" accessibilityRole="header" style={{ textAlign: "center", marginTop: 8, marginBottom: 16 }}>{type === "fix" ? "Current issues" : labels.features}</T>
      {project === null ? (
        <View style={{ padding: 20, gap: 16 }}><T>Project not found</T><Button label="Back to projects" onPress={() => router.replace("/projects" as Href)} testID="begin-not-found-back" /></View>
      ) : cases === undefined || project === undefined ? (
        <T color="textMuted" style={{ textAlign: "center", padding: 20 }}>Loading…</T>
      ) : cases.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}><Turtle health="clear" size={96} /><T color="textMuted">{type === "fix" ? "Nothing to fix." : "No feature requests."}</T></View>
      ) : (
        <>
          <View>
            <ScrollView horizontal testID="begin-case-strip" showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 8, gap: 14 }}>
              {cases.map((item) => {
                const state = issueState(item);
                return <ZoomPressable key={item.id} accessibilityRole="button" testID={`begin-case-${item.id}`} onPress={() => router.push(`/review/${item.id}` as Href)} style={({ pressed }) => ({ width: Math.min(288, width - 64), minHeight: height < 650 ? 224 : 254, borderRadius: 22, borderWidth: 1, borderColor: colors[state.color], backgroundColor: pressed ? colors.surfaceRaised : colors.surface, padding: 20, gap: 18 })}>
                  <T variant="heading" style={{ flex: 1 }}>{item.title}</T>
                  <T variant="small" color="textMuted" testID={`begin-date-${item.id}`}>{exactTime(item.happenedAt)}</T>
                  {type === "feature" && item.reportCount !== undefined && <T variant="small" color="textMuted">{item.reportCount} asked</T>}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }} testID={`begin-status-${item.id}`}><Image source={state.image} style={{ width: 40, height: 40 }} accessibilityLabel={state.label} /><T variant="small" color={state.color} style={{ flexShrink: 1 }}>{state.label}</T></View>
                </ZoomPressable>;
              })}
            </ScrollView>
          </View>
          <View {...pan.panHandlers} style={{ flex: 1, justifyContent: "flex-end", alignItems: "center", paddingBottom: insets.bottom + 24, paddingTop: 16 }}>
            <Pressable onPress={openFirst} accessibilityRole="button" accessibilityLabel="Swipe up to review" testID="begin-review" style={({ pressed }) => ({ alignItems: "center", gap: 8, opacity: pressed ? 0.6 : 1 })}>
              <View style={{ opacity: 0.45 }}><Icon name="ArrowUp" size={height < 650 ? 64 : 84} color="text" strokeWidth={1.15} /></View>
              <T variant="heading">Swipe up to review</T>
            </Pressable>
          </View>
        </>
      )}
    </Screen>
  );
}
