import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCase } from "../../data";
import type { FixOption, Screenshot } from "../../data/types";
import { useTheme } from "../../theme";
import { ago, Button, Card, Chip, devToolsOn, HealthWord, T, Turtle } from "../ui";
import { CodeBox, LogRow, SpanText, Viz } from "./Evidence";
import { ApproveSheet, FixCard } from "./FixCard";

const tabs = ["Overview", "Logs", "Code"] as const;
const phases: Record<Screenshot["phase"], string> = { failure: "When it failed", before: "Before", after: "After" };

export function CasePage({ caseId, current }: { caseId: string; current: boolean }) {
  const c = useCase(caseId);
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
  const id = (name: string) => (current ? name : undefined);

  useEffect(() => {
    setAtFixes(fixesY > 0 && offset.current + height > fixesY + 120);
  }, [fixesY, height]);

  if (c === undefined) return <T style={{ padding: 16 }}>Loading…</T>;
  if (c === null) return <T style={{ padding: 16 }}>This case could not be found.</T>;

  const sources = { citations: c.citations, logs: c.logs, code: c.code };
  const feature = c.type === "feature";
  const e = c.enactment;
  const active = !!e && e.state !== "stopped";
  const activeNumber = e ? c.fixes.findIndex((f) => f.key === e.fixKey) + 1 : 0;
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
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 8 }}>
          {tabs.map((name) => (
            <Pressable
              key={name}
              onPress={() => setTab(name)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === name }}
              testID={id("tab-" + name.toLowerCase())}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderBottomWidth: 3,
                borderBottomColor: tab === name ? colors.brandDeep : "transparent",
              }}
            >
              <T variant={tab === name ? "strong" : "body"} color={tab === name ? "text" : "textMuted"}>
                {name}
              </T>
            </Pressable>
          ))}
        </View>

        <View style={{ padding: 16, gap: 18, minHeight: Math.max(0, height - 150) }}>
          {tab === "Overview" && (
            <>
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <Turtle health={c.health} size={60} />
                <View style={{ flex: 1, gap: 4 }}>
                  <T variant="strong" testID={id("case-summary")}>
                    {c.summary}
                  </T>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10 }}>
                    <HealthWord health={c.health} testID={id("case-health")} />
                    <T variant="small" color="textMuted">
                      {ago(c.happenedAt)}
                    </T>
                    {!!c.reportCount && (
                      <T variant="small" color="textMuted">
                        {c.reportCount + (feature ? " people asked" : " people reported it")}
                      </T>
                    )}
                  </View>
                </View>
              </View>
              {c.learned && (
                <Card style={{ gap: 4, borderColor: colors.statusClear }} testID={id("case-learned")}>
                  <T variant="strong">What turtl learned</T>
                  <T>{c.learned}</T>
                </Card>
              )}
              {c.overview.map((block, i) =>
                block.kind === "paragraph" ? (
                  <SpanText key={i} spans={block.spans} sources={sources} prefix={"overview-" + i} />
                ) : (
                  <Card key={i} style={{ gap: 12 }}>
                    <T variant="strong">{block.title}</T>
                    <Viz viz={block.viz} />
                  </Card>
                ),
              )}
              <View style={{ gap: 10 }}>
                <T variant="heading">Screenshots from app</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
                  {c.screenshots.map((shot) => (
                    <View key={shot.id} style={{ width: 190, gap: 6 }} testID={"screenshot-" + shot.id}>
                      <Image
                        source={{ uri: shot.url }}
                        style={{ width: 190, height: 380, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}
                        accessibilityLabel={shot.caption}
                      />
                      <Chip label={phases[shot.phase]} tone={shot.phase === "failure" ? "statusAffected" : "textMuted"} />
                      <T>{shot.caption}</T>
                    </View>
                  ))}
                </ScrollView>
              </View>
            </>
          )}
          {tab === "Logs" && (
            <>
              <T color="textMuted">What the app and turtl wrote down, oldest first.</T>
              {c.logs.map((line) => (
                <Card key={line.id}>
                  <LogRow line={line} />
                </Card>
              ))}
            </>
          )}
          {tab === "Code" && (
            <>
              <T color="textMuted">The parts of the code this case touches.</T>
              {c.code.map((code) => (
                <Card key={code.id}>
                  <CodeBox code={code} />
                </Card>
              ))}
            </>
          )}
        </View>

        <View
          onLayout={(event) => setFixesY(event.nativeEvent.layout.y)}
          style={{
            padding: 16,
            gap: 12,
            minHeight: height,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.bg,
          }}
          testID={id("fixes-section")}
        >
          <T variant="title" accessibilityRole="header">
            {feature ? "Options" : "Fixes"}
          </T>
          {active && e && (
            <Card style={{ gap: 10, borderColor: colors.statusWorking }} testID={id("fixes-enacting")}>
              <T variant="strong">
                {e.state === "done"
                  ? "Fix " + activeNumber + " is finished."
                  : e.state === "waiting_for_merge"
                    ? "Fix " + activeNumber + " is ready for you to merge."
                    : e.state === "needs_you"
                      ? "Fix " + activeNumber + " stopped and needs your decision."
                      : "turtl is working on Fix " + activeNumber + "."}
              </T>
              <Button label="See the plan" kind="plain" onPress={openEnacting} testID={id("fixes-open-enacting")} />
            </Card>
          )}
          {c.fixes.map((fix, i) => (
            <FixCard
              key={fix.key}
              fix={fix}
              number={i + 1}
              sources={sources}
              defaultOpen={fix.recommended}
              approveDisabled={active}
              onApprove={setApproving}
            />
          ))}
          <Card
            onPress={() => router.push(("/review/" + c.id + "/chat") as never)}
            testID={id("investigate-further")}
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <T variant="strong" color="textMuted" style={{ width: 18 }}>
              ▸
            </T>
            <T variant="strong" style={{ flex: 1 }}>
              Investigate further
            </T>
            <T color="textMuted">Ask turtl</T>
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
            paddingLeft: 16,
            paddingRight: devToolsOn ? 88 : 16,
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
    </View>
  );
}
