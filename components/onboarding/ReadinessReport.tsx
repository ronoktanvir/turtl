import { Linking, Pressable, View } from "react-native";
import type { Onboarding } from "../../data/onboarding/types";
import { useTheme } from "../../theme";
import { T } from "../ui";
import { Glyph } from "./Glyph";
import { readinessWord } from "./stage";

const statusGlyph = { found: "CircleCheck", missing: "CircleDashed", unknown: "CircleQuestionMark" } as const;

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
        {inspection.items.map((item, index) => {
          const status = readinessWord[item.status];
          return (
            <View key={item.key} testID={"prepare-item-" + item.key} style={{ padding: 16, gap: 8, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <T variant="strong" style={{ flex: 1 }}>{item.label}</T>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Glyph name={statusGlyph[item.status]} size={16} color={status.color} />
                  <T variant="small" color={status.color} testID={"prepare-item-" + item.key + "-status"}>{status.word}</T>
                </View>
              </View>
              <T color="textMuted">{item.note}</T>
              {item.status === "found" && item.files.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {item.files.map((file) => (
                    <Pressable key={file.url} accessibilityRole="link" accessibilityLabel={"Open " + file.path} onPress={() => void Linking.openURL(file.url)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceRaised : colors.bg })}>
                      <Glyph name="FileCode" size={14} color="link" />
                      <T variant="mono" color="link">{file.path + (file.line ? ":" + file.line : "")}</T>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}
