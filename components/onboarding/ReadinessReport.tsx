import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import type { FileRef, Onboarding, ReadinessItem } from "../../data/onboarding/types";
import { useTheme } from "../../theme";
import { T } from "../ui";
import { Glyph } from "./Glyph";
import { readinessWord } from "./stage";

const statusGlyph = { found: "CircleCheck", missing: "CircleDashed", unknown: "CircleQuestionMark" } as const;
const shownChips = 3;

function groupFiles(files: FileRef[]) {
  const groups = new Map<string, { path: string; url: string; lines: number[] }>();
  for (const file of files) {
    const group = groups.get(file.path) ?? { path: file.path, url: file.url, lines: [] };
    if (file.line !== undefined && !group.lines.includes(file.line)) group.lines.push(file.line);
    groups.set(file.path, group);
  }
  return [...groups.values()];
}

function ItemRow({ item, first }: { item: ReadinessItem; first: boolean }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const status = readinessWord[item.status];
  const groups = item.status === "found" ? groupFiles(item.files) : [];
  const hidden = groups.length - shownChips;
  return (
    <View testID={"prepare-item-" + item.key} style={{ padding: 16, gap: 8, borderTopWidth: first ? 0 : 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <T variant="strong" style={{ flex: 1 }}>{item.label}</T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Glyph name={statusGlyph[item.status]} size={16} color={status.color} />
          <T variant="small" color={status.color} testID={"prepare-item-" + item.key + "-status"}>{status.word}</T>
        </View>
      </View>
      <T color="textMuted">{item.note}</T>
      {groups.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(expanded ? groups : groups.slice(0, shownChips)).map((group) => (
            <Pressable key={group.path} accessibilityRole="link" accessibilityLabel={"Open " + group.path} testID={"prepare-file-" + item.key} onPress={() => void Linking.openURL(group.url)} style={({ pressed }) => ({ maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceRaised : colors.bg })}>
              <Glyph name="FileCode" size={14} color="link" />
              <T variant="mono" color="link" numberOfLines={1} style={{ flexShrink: 1 }}>{group.path}</T>
              {group.lines.length > 0 && <T variant="mono" color="link" numberOfLines={1} style={{ flexShrink: 0 }}>{group.lines.join(", ")}</T>}
            </Pressable>
          ))}
          {hidden > 0 && (
            <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} testID={"prepare-files-more-" + item.key} style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: 6 }}>
              <T variant="small" color="link">{expanded ? "Show fewer" : "+" + hidden + " more"}</T>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

export function ReadinessReport({ onboarding }: { onboarding: Onboarding }) {
  const { colors } = useTheme();
  const inspection = onboarding.inspection;
  if (!inspection?.items.length) return null;
  const stack = inspection.stack;
  const found = inspection.items.filter((i) => i.status === "found").length;
  return (
    <View style={{ gap: 16 }} testID="prepare-report">
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <T variant="title" accessibilityRole="header">What turtl found</T>
        <T variant="small" color="textMuted" testID="prepare-found-count">{found + " of " + inspection.items.length + " found"}</T>
      </View>
      <View style={{ gap: 6 }}>
        <T variant="strong" testID="prepare-stack">{stack ? stack.label : "Stack not read yet"}</T>
        {stack && !stack.supported && <T color="statusNeedsYou" testID="prepare-unsupported">{"Automatic preparation isn't supported for " + stack.label + " yet. The report below is still accurate."}</T>}
      </View>
      <View style={{ borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        {inspection.items.map((item, index) => <ItemRow key={item.key} item={item} first={index === 0} />)}
      </View>
    </View>
  );
}
