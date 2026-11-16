import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import { AccessibilityInfo, Animated, Easing, Image, Platform, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isLiveData, useCase, useDataStatus, useWorkflow } from "../../data";
import type { FixOption, Screenshot } from "../../data/types";
import { useTheme } from "../../theme";
import { ago, Button, Card, Chip, devToolsOn, HealthWord, Icon, Reveal, T, Turtle, useReducedMotion } from "../ui";
import { Droplet, dropBack, fillDrop, nativeDriver, usePull, useWheelPull } from "../ui/pulse";
import { swipeTravel } from "../ui/swipe";
import { CaseTabs, type CaseTab } from "./CaseTabs";
import { CouncilView } from "./CouncilView";
import { reportLine } from "./counts";
import { CustomerReportsControl } from "./CustomerReports";
import { CodeBox, LogRow, SpanText, Viz } from "./Evidence";
import { ApproveSheet, DeclineSheet, FixCard } from "./FixCard";
import { PreventionCheckCard, StructuralFindingCard } from "./StructuralFinding";
import { WorkflowGraph } from "../execution/WorkflowGraph";

const phases: Record<Screenshot["phase"], string> = { failure: "When it failed", before: "Before", after: "After" };

// An opened issue is two pages. The first is the issue: the Overview, Logs and Code bar and what it shows. The second
// is what to do about it: Fixes, or Options for a feature request. Pulling on past the end of the first page, or the
// button pinned at its foot, spreads turtl's green up from the bottom and Fixes surfaces out of it; pulling down at
// the top of Fixes, or its "Back to overview", does the same from the top. With reduced motion the pages just switch.

type Part = "case" | "fixes";
type Metrics = { y: number; viewport: number; content: number };
const EDGE = 2;
const atEnd = (m: Metrics) => m.y + m.viewport >= m.content - EDGE;
const atTop = (m: Metrics) => m.y <= EDGE;
const BAR = 76; // the pinned button's bar, which the first page's content scrolls clear of

function tracking(metrics: RefObject<Metrics>) {
  return {
    scrollEventThrottle: 16,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      metrics.current = { y: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height };
    },
    onLayout: (event: LayoutChangeEvent) => {
      metrics.current = { ...metrics.current, viewport: event.nativeEvent.layout.height };
    },
    onContentSizeChange: (_width: number, height: number) => {
      metrics.current = { ...metrics.current, content: height };
    },
  };
}

type ViewNode = ComponentRef<typeof View>;

/** Puts keyboard and screen reader focus on a view, as after a move between pages. */
function focus(view: ViewNode | null) {
  if (!view) return;
  if (Platform.OS === "web") (view as unknown as HTMLElement).focus?.({ preventScroll: true });
  else AccessibilityInfo.sendAccessibilityEvent(view, "focus");
}

export function CasePage({ caseId, current }: { caseId: string; current: boolean }) {
  const c = useCase(caseId);
  const workflow = useWorkflow(caseId);
  const { errors } = useDataStatus();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const reduced = useReducedMotion();
  const [tab, setTab] = useState<CaseTab>("Overview");
  const [part, setPart] = useState<Part>("case");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const drop = useRef(new Animated.Value(0)).current; // the green spreading toward the other page
  const veil = useRef(new Animated.Value(0)).current; // the green the arriving page surfaces out of
  const moving = useRef(false);
  const pulled = useRef(0);
  const arrived = useRef<Part | null>(null);
  const caseMetrics = useRef<Metrics>({ y: 0, viewport: 0, content: 0 });
  const fixesMetrics = useRef<Metrics>({ y: 0, viewport: 0, content: 0 });
  const fixesScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const lookAtFixes = useRef<ViewNode>(null);
  const backToCase = useRef<ViewNode>(null);
  const [approving, setApproving] = useState<FixOption | null>(null);
  const [declining, setDeclining] = useState(false);
  const id = (name: string) => (current ? name : caseId + "-" + name);
  const toward: Part = part === "case" ? "fixes" : "case";

  // Focus follows the move, so a keyboard or screen reader user lands on the way back.
  useEffect(() => {
    if (!arrived.current) return;
    const landed = arrived.current;
    arrived.current = null;
    if (current) focus(landed === "fixes" ? backToCase.current : lookAtFixes.current);
  }, [part, current]);

  const arrive = (target: Part, refocus: boolean) => {
    arrived.current = refocus ? target : null;
    if (target === "fixes") {
      fixesScroll.current?.scrollTo({ y: 0, animated: false });
      fixesMetrics.current = { ...fixesMetrics.current, y: 0 };
    }
    setPart(target);
  };
  /** Moves to the other page. From a button, focus moves with it; after a swipe or a scroll it is left alone. */
  const go = (target: Part, refocus: boolean) => {
    if (moving.current || target === part) return;
    if (reduced) return arrive(target, refocus);
    moving.current = true;
    fillDrop(drop, pulled.current, () => {
      arrive(target, refocus);
      veil.setValue(1);
      drop.setValue(0);
      pulled.current = 0;
      Animated.timing(veil, { toValue: 0, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver }).start(() => {
        moving.current = false;
      });
    });
  };
  const follow = (progress: number) => {
    if (reduced || moving.current) return;
    pulled.current = progress;
    drop.setValue(progress);
  };
  const release = (complete: boolean) => {
    if (moving.current) return;
    if (complete) return go(toward, false);
    pulled.current = 0;
    dropBack(drop);
  };
  const travel = swipeTravel(box.height);
  const casePull = usePull({ direction: "up", travel, mouse: false, canStart: () => part === "case" && !moving.current && atEnd(caseMetrics.current), onStart: () => drop.stopAnimation(), onPull: follow, onRelease: release });
  const fixesPull = usePull({ direction: "down", travel, mouse: false, canStart: () => part === "fixes" && !moving.current && atTop(fixesMetrics.current), onStart: () => drop.stopAnimation(), onPull: follow, onRelease: release });
  const wheel = useWheelPull({
    direction: () => (part === "case" ? 1 : -1),
    atEdge: () => (part === "case" ? atEnd(caseMetrics.current) : atTop(fixesMetrics.current)),
    busy: () => moving.current,
    onPull: follow,
    onRelease: release,
  });

  if (c === undefined) return errors.length === 0 ? <T style={{ padding: 16 }}>Loading…</T> : null;
  if (c === null) return <T style={{ padding: 16 }}>This case could not be found.</T>;

  const sources = { citations: c.citations, logs: c.logs, code: c.code };
  const feature = c.type === "feature";
  const e = c.enactment;
  const active = !!e && e.state !== "stopped";
  const activeNumber = e ? c.fixes.findIndex((f) => f.key === e.fixKey) + 1 : 0;
  const closed = c.status === "declined" || c.status === "resolved" || c.status === "unresolved";
  const openEnacting = () => router.push(("/review/" + c.id + "/enacting") as never);
  // The page being left lifts away with the pull; the page arriving settles into place as the green clears.
  const shift = (away: number, settle: number) => Animated.add(
    drop.interpolate({ inputRange: [0, 1], outputRange: [0, away], extrapolate: "clamp" }),
    veil.interpolate({ inputRange: [0, 1], outputRange: [0, settle] }),
  );
  const leaving = drop.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55], extrapolate: "clamp" });

  return (
    <View style={{ flex: 1, overflow: "hidden" }} ref={wheel} onLayout={(event) => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
      <Animated.View
        {...casePull}
        style={[StyleSheet.absoluteFill, { display: part === "case" ? "flex" : "none", opacity: leaving, transform: [{ translateY: shift(-36, -20) }] }]}
        testID={id("case-part")}
      >
        <CaseTabs tab={tab} onSelect={setTab} id={id} />
        <ScrollView {...tracking(caseMetrics)} contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: BAR + insets.bottom + 24 }} testID={"case-scroll-" + c.id}>
          {tab === "Overview" && (
            <>
              <Reveal>
                <View style={{ gap: 12 }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, alignItems: "center" }}>
                    {c.status === "new" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} testID={id("case-health")}><Icon name="Plus" size={15} color="statusNew" /><T variant="small" color="statusNew">New issue</T></View> : <HealthWord health={c.health} testID={id("case-health")} />}
                    <T variant="small" color="textMuted">
                      {ago(c.happenedAt)}
                    </T>
                  </View>
                  <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                    {c.status === "new" ? <Image source={require("../../assets/turtle/new.png")} style={{ width: 44, height: 44 }} accessibilityLabel="New issue" /> : <Turtle health={c.health} size={44} />}
                    <T variant="strong" style={{ flex: 1 }} testID={id("case-summary")}>{c.summary || "No summary has been recorded yet."}</T>
                  </View>
                    {!!c.reportCount && (
                      <T variant="small" color="textMuted" style={{ paddingLeft: 56 }}>
                        {reportLine(c.reportCount, feature)}
                      </T>
                    )}
                </View>
              </Reveal>
              {c.structural && <StructuralFindingCard finding={c.structural} sources={sources} id={id} />}
              {isLiveData && (workflow ? <WorkflowGraph key={caseId} workflow={workflow} /> : <T color="textMuted">{workflow === undefined ? "Loading Plan…" : "No workflow has been recorded for this case."}</T>)}
              {c.overview.length === 0 && <T color="textMuted" testID={id("overview-empty")}>No overview evidence has been collected yet.</T>}
              {c.overview.map((block, i) =>
                block.kind === "paragraph" ? (
                  <SpanText key={i} spans={block.spans} sources={sources} prefix={"overview-" + i} />
                ) : (
                  <View key={i} style={{ gap: 20, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border, paddingVertical: 20 }}>
                    <T variant="heading">{block.title}</T>
                    <Viz viz={block.viz} />
                  </View>
                ),
              )}
              <CustomerReportsControl caseId={c.id} id={id} />
              <View style={{ gap: 12 }}>
                <T variant="heading">Screenshots from app</T>
                {c.screenshots.length === 0 && <T color="textMuted">No screenshots have been collected yet.</T>}
                <ScrollView horizontal testID={id("screenshots-strip")} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
                  {c.screenshots.map((shot) => (
                    <View key={shot.id} style={{ width: 208, gap: 10 }} testID={"screenshot-" + shot.id}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                        <Chip label={phases[shot.phase]} tone={shot.phase === "failure" ? "statusAffected" : shot.phase === "after" ? "statusClear" : "textMuted"} />
                      </View>
                      <Image
                        source={{ uri: shot.url }}
                        style={{ width: 208, height: 392, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}
                        resizeMode="contain"
                        accessibilityLabel={shot.caption}
                      />
                      <T color="textMuted">{shot.caption}</T>
                    </View>
                  ))}
                </ScrollView>
              </View>
            </>
          )}
          {tab === "Logs" && (
            <>
              <CouncilView caseId={c.id} prefix={id("")} />
              {c.logs.length === 0 && <T color="textMuted" testID={id("logs-empty")}>No logs have been collected yet.</T>}
              <View style={{ gap: 20 }}>
              {c.logs.map((line) => (
                <View key={line.id} style={{ paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <LogRow line={line} />
                </View>
              ))}
              </View>
            </>
          )}
          {tab === "Code" && (
            <>
              {c.code.length === 0 && <T color="textMuted" testID={id("code-empty")}>No code evidence has been collected yet.</T>}
              {c.code.map((code) => (
                <View key={code.id}>
                  <CodeBox code={code} />
                </View>
              ))}
            </>
          )}
        </ScrollView>
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingLeft: 20,
            paddingTop: 12,
            backgroundColor: colors.bg,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingRight: devToolsOn ? 88 : 20,
            paddingBottom: insets.bottom + 12,
          }}
        >
          <Button
            ref={lookAtFixes}
            label={feature ? "Look at options" : "Look at potential fixes"}
            onPress={() => go("fixes", true)}
            testID={id("look-at-fixes")}
          />
        </View>
      </Animated.View>

      <Animated.View
        {...fixesPull}
        style={[StyleSheet.absoluteFill, { display: part === "fixes" ? "flex" : "none", opacity: leaving, transform: [{ translateY: shift(36, 24) }] }]}
        testID={id("fixes-part")}
      >
        <Pressable
          ref={backToCase}
          onPress={() => go("case", true)}
          accessibilityRole="button"
          accessibilityLabel="Back to overview"
          testID={id("fixes-back")}
          style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: pressed ? colors.surface : colors.bg })}
        >
          <Icon name="ArrowUp" size={15} color="textMuted" />
          <T variant="small" color="textMuted" selectable={false}>Back to overview</T>
        </Pressable>
        <ScrollView
          ref={fixesScroll}
          {...tracking(fixesMetrics)}
          contentContainerStyle={{ padding: 20, paddingTop: 24, gap: 20, paddingBottom: insets.bottom + (devToolsOn ? 72 : 32) }}
          testID={id("fixes-section")}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
            {!feature && <Reveal replayKey={part}><Image source={require("../../assets/turtle/detective.png")} style={{ width: 76, height: 76 }} accessibilityLabel="turtl investigating possible fixes" /></Reveal>}
            <T variant="title" accessibilityRole="header">{feature ? "Options" : "Fixes"}</T>
          </View>
          {active && e && (
            <Card style={{ gap: 10, borderColor: colors.statusWorking }} testID={id("fixes-enacting")}>
              <T variant="strong">
                {e.state === "done"
                  ? "Fix " + activeNumber + " is finished."
                  : e.state === "waiting_for_merge"
                    ? "Fix " + activeNumber + " is ready for you to merge."
                    : e.state === "needs_you"
                      ? "Fix " + activeNumber + " stopped and needs your decision."
                      : e.state === "failed"
                        ? "Fix " + activeNumber + " did not work."
                      : "turtl is working on Fix " + activeNumber + "."}
              </T>
              <Button label="See the plan" kind="plain" onPress={openEnacting} testID={id("fixes-open-enacting")} />
            </Card>
          )}
          {c.fixes.length === 0 && <T color="textMuted">No fixes have been proposed yet. This report needs investigation first.</T>}
          {c.fixes.map((fix, i) => (
            <FixCard
              key={fix.key}
              fix={fix}
              number={i + 1}
              sources={sources}
              defaultOpen={fix.recommended}
              approveDisabled={active || c.status === "declined"}
              onApprove={setApproving}
            />
          ))}
          {c.structural?.check && <PreventionCheckCard finding={c.structural} id={id} />}
          {c.status === "declined" && <View style={{ flexDirection: "row", gap: 8 }} testID={id("fixes-declined")}><Icon name="X" size={18} color="textMuted" /><T color="textMuted" style={{ flex: 1 }}>You declined these fixes. Nothing was changed, and this case is closed.</T></View>}
          {c.fixes.length > 0 && !active && !closed && <Button label="Decline these fixes" kind="plain" onPress={() => setDeclining(true)} testID={id("fixes-decline")} />}
          <Card
            onPress={() => router.push(("/review/" + c.id + "/chat") as never)}
            testID={id("investigate-further")}
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <Icon name="MessageCircle" color="brandDeep" />
            <T variant="strong" style={{ flex: 1 }}>
              Investigate further
            </T>
            <Icon name="ArrowRight" color="textMuted" />
          </Card>
        </ScrollView>
      </Animated.View>

      <Droplet value={drop} x={box.width / 2} y={toward === "fixes" ? box.height : 0} reach={Math.hypot(box.width / 2, box.height) + 2} />
      <Animated.View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: colors.brandDeep, opacity: veil }]} />
      <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} />
      <DeclineSheet caseId={c.id} visible={declining} onClose={() => setDeclining(false)} />
    </View>
  );
}
