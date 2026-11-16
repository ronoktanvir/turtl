import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Citation, CodeRef, LogLine, Span, Visualization } from "../../data/types";
import { useTheme, type TokenName } from "../../theme";
import { ago, Icon, T } from "../ui";

export type Sources = { citations: Citation[]; logs: LogLine[]; code: CodeRef[] };

const levels: Record<LogLine["level"], { word: string; tone: TokenName }> = {
  info: { word: "· Info", tone: "textMuted" },
  warn: { word: "! Warning", tone: "statusNeedsYou" },
  error: { word: "✕ Error", tone: "statusAffected" },
};

function clock(at: number) {
  const date = new Date(at);
  const hours = date.getHours();
  return (hours % 12 || 12) + ":" + String(date.getMinutes()).padStart(2, "0") + (hours < 12 ? " AM" : " PM");
}

export function LogRow({ line }: { line: LogLine }) {
  return (
    <View style={{ gap: 8 }} testID={"log-" + line.id}>
      <T variant="small" color={levels[line.level].tone} style={{ fontWeight: "700" }}>
        {levels[line.level].word}
        <T variant="small" color="textMuted">
          {"  " + line.source + " · " + clock(line.at)}
        </T>
      </T>
      <T variant="mono" style={{ fontSize: 15, lineHeight: 24 }}>{line.text}</T>
    </View>
  );
}

export function CodeBox({ code }: { code: CodeRef }) {
  const { colors } = useTheme();
  const block = (label: string, text: string, sign: string, backgroundColor: string) => (
    <View style={{ gap: 8 }}>
      <T variant="small" color="textMuted" style={{ fontWeight: "600" }}>
        {label}
      </T>
      <ScrollView horizontal testID={"code-scroll-" + code.id + "-" + sign} style={{ backgroundColor, borderRadius: 12 }} contentContainerStyle={{ paddingVertical: 12, paddingRight: 16, minWidth: "100%" }}>
        <View>
          {text.split("\n").map((line, i) => (
            <View key={i} style={{ flexDirection: "row", minHeight: 25 }}>
              <T variant="mono" color="textMuted" style={{ width: 44, textAlign: "right", paddingRight: 12 }}>{code.startLine + i}</T>
              <T variant="mono" style={{ width: 20 }}>{sign}</T>
              <T variant="mono" style={{ lineHeight: 25 }}>{line || " "}</T>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
  return (
    <View style={{ gap: 12 }} testID={"code-" + code.id}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Icon name="Code2" size={18} color="brandDeep" />
        <T variant="mono" color="textMuted" style={{ flex: 1 }}>{code.path}</T>
      </View>
      {code.note && <T>{code.note}</T>}
      {block(
        code.after ? "The code now" : "The code",
        code.before,
        code.after ? "−" : " ",
        code.after ? colors.codeDelBg : colors.surfaceRaised,
      )}
      {code.after && block("What replaces it", code.after, "+", colors.codeAddBg)}
    </View>
  );
}

export function SpanText({ spans, sources, prefix }: { spans: Span[]; sources: Sources; prefix: string }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  const citation = sources.citations.find((c) => c.id === open);
  const log = citation?.kind === "log" ? sources.logs.find((l) => l.id === citation.logId) : undefined;
  const code = citation?.kind === "code" ? sources.code.find((c) => c.id === citation.codeId) : undefined;
  return (
    <View style={{ gap: 10 }}>
      <T>
        {spans.map((span, i) => {
          const cite = span.cite;
          if (!cite) return span.text;
          return (
            <Text
              key={i}
              onPress={() => setOpen(open === cite ? null : cite)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open === cite }}
              testID={prefix + "-cite-" + cite}
              style={{
                color: colors.link,
                textDecorationLine: "underline",
                fontWeight: "600",
              }}
            >
              {span.text}
            </Text>
          );
        })}
      </T>
      {open && (log || code) && (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderLeftWidth: 3,
            borderLeftColor: colors.brandDeep,
            backgroundColor: colors.surface,
            borderRadius: 16,
            padding: 16,
            gap: 12,
          }}
          testID={prefix + "-cite-box-" + open}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <T variant="small" color="textMuted" style={{ fontWeight: "700" }}>
              {log ? "From the logs" : "From the code"}
            </T>
            <Pressable
              onPress={() => setOpen(null)}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID={prefix + "-cite-close-" + open}
              hitSlop={12}
            >
              <Icon name="X" size={18} color="textMuted" />
            </Pressable>
          </View>
          {log && <LogRow line={log} />}
          {code && <CodeBox code={code} />}
        </View>
      )}
    </View>
  );
}

const journeyStates: Record<"passed" | "failed" | "not_reached", { word: string; tone: TokenName }> = {
  passed: { word: "Worked", tone: "statusClear" },
  failed: { word: "Stops here", tone: "statusAffected" },
  not_reached: { word: "Never reached", tone: "textMuted" },
};

export function Viz({ viz }: { viz: Visualization }) {
  const { colors } = useTheme();
  if (viz.type === "journey") {
    return (
      <View style={{ paddingHorizontal: 2 }}>
        {viz.steps.map((step, i) => {
          const state = journeyStates[step.state];
          return (
            <View key={i} style={{ flexDirection: "row", gap: 16 }}>
              <View style={{ alignItems: "center", width: 30 }}>
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    borderWidth: 1,
                    borderColor: colors[state.tone],
                    backgroundColor: step.state === "failed" ? colors.codeDelBg : colors.surface,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {step.state === "not_reached" ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.textMuted }} /> : <Icon name={step.state === "passed" ? "Check" : "X"} size={15} color={state.tone} />}
                </View>
                {i < viz.steps.length - 1 && (
                  <View style={{ width: 1, flex: 1, minHeight: 18, backgroundColor: colors.border }} />
                )}
              </View>
              <View style={{ flex: 1, paddingBottom: i < viz.steps.length - 1 ? 20 : 0, gap: 2 }}>
                <T variant={step.state === "failed" ? "strong" : "body"} color={step.state === "not_reached" ? "textMuted" : "text"}>
                  {step.label}
                </T>
                <T variant="small" color={state.tone} style={{ fontWeight: "600" }}>
                  {state.word}
                </T>
              </View>
            </View>
          );
        })}
      </View>
    );
  }
  const max = Math.max(...viz.points.map((p) => p.v), 1);
  const first = viz.points[0];
  const last = viz.points[viz.points.length - 1];
  if (!first || !last) return <T color="textMuted">No measurements yet.</T>;
  const amount = (v: number) => v + (viz.unit === "%" ? "%" : " " + viz.unit);
  const markerAt = viz.markerAt;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ height: 110, flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
        {viz.points.map((point) => (
          <View
            key={point.t}
            style={{
              flex: 1,
              height: Math.max(4, (point.v / max) * 110),
              borderRadius: 3,
              backgroundColor: markerAt !== undefined && point.t >= markerAt ? colors.statusAffected : colors.statusWorking,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T variant="small" color="textMuted">
          {ago(first.t)}
        </T>
        <T variant="small" color="textMuted">
          {ago(last.t)}
        </T>
      </View>
      <T>
        {viz.label + " went from " + amount(first.v) + " to " + amount(last.v) + "."}
        {markerAt !== undefined && " The change began " + ago(markerAt) + "."}
      </T>
    </View>
  );
}
