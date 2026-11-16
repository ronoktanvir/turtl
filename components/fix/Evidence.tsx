import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Citation, CodeRef, LogLine, Span, Visualization } from "../../data/types";
import { useTheme, type TokenName } from "../../theme";
import { ago, T } from "../ui";

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
    <View style={{ gap: 2 }} testID={"log-" + line.id}>
      <T variant="small" color={levels[line.level].tone} style={{ fontWeight: "700" }}>
        {levels[line.level].word}
        <T variant="small" color="textMuted">
          {"  " + line.source + " · " + clock(line.at)}
        </T>
      </T>
      <T>{line.text}</T>
    </View>
  );
}

export function CodeBox({ code }: { code: CodeRef }) {
  const { colors } = useTheme();
  const block = (label: string, text: string, sign: string, backgroundColor: string) => (
    <View style={{ gap: 4 }}>
      <T variant="small" color="textMuted" style={{ fontWeight: "700" }}>
        {label}
      </T>
      <View style={{ backgroundColor, borderRadius: 8, padding: 10 }}>
        {text.split("\n").map((line, i) => (
          <T key={i} variant="mono">
            {sign + " " + line}
          </T>
        ))}
      </View>
    </View>
  );
  return (
    <View style={{ gap: 10 }} testID={"code-" + code.id}>
      {code.note && <T>{code.note}</T>}
      <T variant="mono" color="textMuted">
        {code.path + ", line " + code.startLine}
      </T>
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
              accessibilityRole="link"
              testID={prefix + "-cite-" + cite}
              style={{
                color: colors.link,
                backgroundColor: colors.surfaceRaised,
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
            borderColor: colors.link,
            backgroundColor: colors.bg,
            borderRadius: 12,
            padding: 12,
            gap: 8,
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
              <T variant="heading" color="textMuted">
                ×
              </T>
            </Pressable>
          </View>
          {log && <LogRow line={log} />}
          {code && <CodeBox code={code} />}
        </View>
      )}
    </View>
  );
}

const journeyStates: Record<"passed" | "failed" | "not_reached", { symbol: string; word: string; tone: TokenName }> = {
  passed: { symbol: "✓", word: "Worked", tone: "statusClear" },
  failed: { symbol: "✕", word: "Stops here", tone: "statusAffected" },
  not_reached: { symbol: "·", word: "Never reached", tone: "textMuted" },
};

export function Viz({ viz }: { viz: Visualization }) {
  const { colors } = useTheme();
  if (viz.type === "journey") {
    return (
      <View>
        {viz.steps.map((step, i) => {
          const state = journeyStates[step.state];
          return (
            <View key={i} style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ alignItems: "center", width: 30 }}>
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    borderWidth: 2,
                    borderColor: colors[state.tone],
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <T variant="small" color={state.tone} style={{ fontWeight: "700" }}>
                    {state.symbol}
                  </T>
                </View>
                {i < viz.steps.length - 1 && (
                  <View style={{ width: 2, flex: 1, minHeight: 12, backgroundColor: colors.border }} />
                )}
              </View>
              <View style={{ flex: 1, paddingBottom: 12 }}>
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
