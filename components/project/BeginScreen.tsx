import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Animated, Image, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCases, useDataStatus, useProject } from "../../data";
import type { CaseSummary, CaseType } from "../../data/types";
import { labels, useTheme, type TokenName } from "../../theme";
import { Button, EdgeFade, Icon, Screen, T, Turtle, ZoomPressable, useReducedMotion } from "../ui";
import { DROP_FULL, Droplet, dropBack, fillDrop, handOffPulse, usePull, useWheelPull } from "../ui/pulse";
import { swipeTravel } from "../ui/swipe";

function issueState(item: CaseSummary): { label: string; color: TokenName; image: number } {
  if (item.status === "resolved") return { label: "Resolved", color: "statusClear", image: require("../../assets/turtle/clear.png") };
  if (item.status === "declined") return { label: "Declined", color: "textMuted", image: require("../../assets/turtle/needs_you.png") };
  if (item.status === "unresolved") return { label: "Unresolved", color: "statusAffected", image: require("../../assets/turtle/affected-laptop.png") };
  if (item.health === "affected") return { label: "Urgent issue", color: "statusAffected", image: require("../../assets/turtle/affected-laptop.png") };
  if (item.status === "needs_approval" || item.status === "ready_to_merge") return { label: "Needs review", color: "statusReview", image: require("../../assets/turtle/review.png") };
  if (item.status === "new") return { label: "New issue", color: "statusNew", image: require("../../assets/turtle/new.png") };
  return { label: "Currently working", color: "statusWorking", image: require("../../assets/turtle/working-laptop.png") };
}

function exactTime(at: number) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

// The list of open issues fills the top half; the bottom half is where you begin. Swiping up there spreads a drop of
// green from the arrow, as far as the finger has gone, and once it fills the screen the first issue opens out of it.
export default function BeginScreen({ type }: { type: CaseType }) {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const cases = useCases(projectId, type);
  const { errors } = useDataStatus();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const firstId = cases?.[0]?.id;
  const drop = useRef(new Animated.Value(0)).current;
  const pulled = useRef(0);
  const opening = useRef(false);
  const [zone, setZone] = useState({ y: 0, height: 0 });
  const [arrowY, setArrowY] = useState(0);
  const [list, setList] = useState({ y: 0, viewport: 0, content: 0 });
  const arrowSize = height < 650 ? 64 : 84;

  // The list starts afresh each time it is shown, so coming back from an issue finds the arrow, not the green.
  useFocusEffect(useCallback(() => {
    drop.stopAnimation();
    drop.setValue(0);
    pulled.current = 0;
    opening.current = false;
  }, [drop]));

  const begin = () => {
    if (!firstId || opening.current) return;
    opening.current = true;
    const open = () => router.push(`/review/${firstId}` as Href);
    if (reduced) return open();
    fillDrop(drop, pulled.current, () => {
      handOffPulse();
      open();
    });
  };
  const follow = (progress: number) => {
    if (reduced || opening.current) return;
    pulled.current = progress;
    drop.setValue(progress);
  };
  const release = (complete: boolean) => {
    if (complete) return begin();
    pulled.current = 0;
    dropBack(drop);
  };
  const pull = usePull({ direction: "up", travel: swipeTravel(height), mouse: true, canStart: () => !!firstId && !opening.current, onStart: () => drop.stopAnimation(), onPull: follow, onRelease: release });
  const wheel = useWheelPull({ direction: () => 1, atEdge: () => !!firstId, busy: () => opening.current, onPull: follow, onRelease: release });

  const centre = insets.top + zone.y + arrowY; // the arrow's centre, from the top of the window
  const reach = Math.hypot(width / 2, Math.max(centre, height - centre)) + 2;
  const listed = project && cases && cases.length > 0;

  return (
    <Screen testID={`begin-${type}`}>
      <View style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to project" testID="header-back" onPress={() => router.canGoBack() ? router.back() : router.replace(`/project/${projectId}` as Href)} style={{ marginLeft: 12, marginTop: 4, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Icon name="ArrowLeft" color="textMuted" />
        </Pressable>
        <T variant="heading" accessibilityRole="header" style={{ textAlign: "center", marginBottom: 14 }}>{type === "fix" ? "Current issues" : labels.features}</T>
        {project === null ? (
          <View style={{ padding: 20, gap: 16 }}><T>Project not found</T><Button label="Back to projects" onPress={() => router.replace("/projects" as Href)} testID="begin-not-found-back" /></View>
        ) : cases === undefined || project === undefined ? (
          <View>{errors.length === 0 && <T color="textMuted" style={{ textAlign: "center", padding: 20 }}>Loading…</T>}</View>
        ) : cases.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}><Turtle health="clear" size={96} /><T color="textMuted">{type === "fix" ? "Nothing to fix." : "No feature requests."}</T></View>
        ) : (
          <View style={{ flex: 1 }}>
            <ScrollView
              testID="begin-case-strip"
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
              scrollEventThrottle={32}
              onLayout={(event) => setList((now) => ({ ...now, viewport: event.nativeEvent.layout.height }))}
              onContentSizeChange={(_, content) => setList((now) => ({ ...now, content }))}
              onScroll={(event) => { const y = event.nativeEvent.contentOffset.y; setList((now) => (now.y === y ? now : { ...now, y })); }}
            >
              {cases.map((item) => {
                const state = issueState(item);
                const date = exactTime(item.happenedAt);
                return (
                  <ZoomPressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={item.title + ". " + state.label + ". " + date}
                    testID={`begin-case-${item.id}`}
                    onPress={() => router.push(`/review/${item.id}` as Href)}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 10, paddingLeft: 12, paddingRight: 16, borderRadius: 16, borderWidth: 1, borderColor: colors[state.color], backgroundColor: pressed ? colors.surfaceRaised : colors.surface })}
                  >
                    <View testID={`begin-status-${item.id}`}>
                      <Image source={state.image} style={{ width: 36, height: 36 }} resizeMode="contain" accessibilityLabel={state.label} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T variant="heading" numberOfLines={2}>{item.title}</T>
                      <T variant="small" color="textMuted" testID={`begin-date-${item.id}`}>{date}</T>
                    </View>
                  </ZoomPressable>
                );
              })}
            </ScrollView>
            {list.y + list.viewport < list.content - 4 && <EdgeFade edge="bottom" size={36} />}
          </View>
        )}
      </View>
      {listed && (
        <View
          ref={wheel}
          {...pull}
          onLayout={(event) => setZone({ y: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height })}
          style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: insets.bottom }}
          testID="begin-swipe-zone"
        >
          <Droplet value={drop} x={width / 2} y={arrowY} reach={reach} />
          <Pressable
            onPress={begin}
            onLayout={(event) => setArrowY(event.nativeEvent.layout.y + 16 + arrowSize / 2)}
            accessibilityRole="button"
            accessibilityLabel="Begin review"
            accessibilityHint="Opens the first issue"
            testID="begin-review"
            style={({ pressed }) => ({ alignItems: "center", gap: 10, padding: 16, borderRadius: 24, opacity: pressed ? 0.7 : 1 })}
          >
            <Animated.View style={{ alignItems: "center", gap: 10, transform: [{ translateY: drop.interpolate({ inputRange: [0, 1, DROP_FULL], outputRange: [0, -24, -56], extrapolate: "clamp" }) }] }}>
              <View style={{ width: arrowSize, height: arrowSize }}>
                <Animated.View style={{ position: "absolute", opacity: drop.interpolate({ inputRange: [0, 0.05], outputRange: [0.45, 0], extrapolate: "clamp" }) }}>
                  <Icon name="ArrowUp" size={arrowSize} color="text" strokeWidth={1.15} />
                </Animated.View>
                <Animated.View style={{ position: "absolute", opacity: drop.interpolate({ inputRange: [0, 0.02, 0.07, 0.9, DROP_FULL], outputRange: [0, 0, 1, 1, 0], extrapolate: "clamp" }) }}>
                  <Icon name="ArrowUp" size={arrowSize} color="onBrand" strokeWidth={1.4} />
                </Animated.View>
              </View>
              <Animated.View style={{ opacity: drop.interpolate({ inputRange: [0, 0.12], outputRange: [1, 0], extrapolate: "clamp" }) }}>
                <T variant="heading" font="text" selectable={false} style={{ textAlign: "center" }}>Swipe up to begin review</T>
              </Animated.View>
            </Animated.View>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}
