import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCase, useDataStatus } from "../../data";
import type { FixOption, Screenshot } from "../../data/types";
import { useTheme } from "../../theme";
import { ago, Button, Card, Chip, devToolsOn, HealthWord, Icon, Reveal, T, Turtle } from "../ui";
import { CouncilView } from "./CouncilView";
import { CodeBox, LogRow, SpanText, Viz } from "./Evidence";
import { ApproveSheet, DeclineSheet, FixCard } from "./FixCard";
import { StructuralFindingCard } from "./StructuralFinding";

const tabs = ["Overview", "Logs", "Code"] as const;
const tabIcons = { Overview: "Layers", Logs: "Terminal", Code: "Code2" } as const;
const phases: Record<Screenshot["phase"], string> = { failure: "When it failed", before: "Before", after: "After" };

export function CasePage({ caseId, current }: { caseId: string; current: boolean }) {
  const c = useCase(caseId);
  const { errors } = useDataStatus();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [fixesY, setFixesY] = useState(0);
  const [height, setHeight] = useState(0);
  const [atFixes, setAtFixes] = useState(false);
  const [approving, setApproving] = useState<FixOption | null>(null);
  const [declining, setDeclining] = useState(false);
  const id = (name: string) => (current ? name : caseId + "-" + name);

  useEffect(() => {
    setAtFixes(fixesY > 0 && offset.current + height > fixesY + 120);
  }, [fixesY, height]);

  if (c === undefined) return errors.length === 0 ? <T style={{ padding: 16 }}>Loading…</T> : null;
  if (c === null) return <T style={{ padding: 16 }}>This case could not be found.</T>;

  const sources = { citations: c.citations, logs: c.logs, code: c.code };
  const feature = c.type === "feature";
  const e = c.enactment;
  const active = !!e && e.state !== "stopped";
  const activeNumber = e ? c.fixes.findIndex((f) => f.key === e.fixKey) + 1 : 0;
  const closed = c.status === "declined" || c.status === "resolved" || c.status === "unresolved";
  const openEnacting = () => router.push(("/review/" + c.id + "/enacting") as never);

  return (
    <View style={{ flex: 1 }} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      <ScrollView
        ref={scroll}
        scrollEventThrottle={32}
        onScroll={(event) => {
          offset.current = event.nativeEvent.contentOffset.y;
          setAtFixes(fixesY > 0 && offset.current + height > fixesY + 120);
        }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        testID={"case-scroll-" + c.id}
      >
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 20, gap: 20 }}>
          {tabs.map((name) => (
            <Pressable
              key={name}
              onPress={() => setTab(name)}
              accessibilityRole="tab"
              aria-selected={tab === name}
              accessibilityState={{ selected: tab === name }}
              testID={id("tab-" + name.toLowerCase())}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                paddingVertical: 12,
                borderBottomWidth: 2,
                borderBottomColor: tab === name ? colors.brandDeep : "transparent",
              }}
            >
              <Icon name={tabIcons[name]} size={17} color={tab === name ? "brandDeep" : "textMuted"} />
              <T variant={tab === name ? "strong" : "body"} color={tab === name ? "text" : "textMuted"}>
                {name}
              </T>
            </Pressable>
          ))}
        </View>

        <View style={{ padding: 20, gap: 20, minHeight: Math.max(0, height - 150) }}>
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
                        {c.reportCount + (feature ? " people asked" : " people reported it")}
                      </T>
                    )}
                </View>
              </Reveal>
              {c.structural && <StructuralFindingCard finding={c.structural} sources={sources} id={id} />}
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
              <CouncilView caseId={c.id} prefix={id("")} />
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
        </View>

        <View
          onLayout={(event) => setFixesY(event.nativeEvent.layout.y)}
          style={{
            padding: 20,
            paddingTop: 28,
            gap: 20,
            minHeight: height,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.bg,
          }}
          testID={id("fixes-section")}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
            {!feature && <Reveal><Image source={require("../../assets/turtle/detective.png")} style={{ width: 76, height: 76 }} accessibilityLabel="turtl investigating possible fixes" /></Reveal>}
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
        </View>
      </ScrollView>

      {!atFixes && (
        <View
          pointerEvents="box-none"
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
            label={feature ? "Look at options" : "Look at potential fixes"}
            onPress={() => scroll.current?.scrollTo({ y: fixesY, animated: true })}
            testID={id("look-at-fixes")}
          />
        </View>
      )}
      <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} />
      <DeclineSheet caseId={c.id} visible={declining} onClose={() => setDeclining(false)} />
    </View>
  );
}
