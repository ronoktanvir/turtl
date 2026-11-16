import { useState } from "react";
import { View } from "react-native";
import { FAILURE_WORDS, usePractice } from "../../data/practice";
import { useTheme } from "../../theme";
import { Icon, T, ZoomPressable } from "../ui";
import PracticeSheet from "./PracticeSheet";

// On a practice project's home, where another project has Investigate (a practice app has no code to map): the button
// that opens the practice sheet, saying where the practice app stands.

export default function PracticeTile({ projectId, short, padding }: { projectId: string; short: boolean; padding: number }) {
  const practice = usePractice();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const project = practice?.project?.projectId === projectId ? practice.project : null;
  const line = !practice
    ? "Loading your practice app…"
    : !project
      ? "This practice app is not available."
      : project.caseId
        ? "turtl is working on it. Follow it under Fix."
        : project.failure
          ? FAILURE_WORDS[project.failure].title + ". Waiting for turtl to notice."
          : "Break it on purpose and watch turtl fix it.";
  const broken = !!project?.failure;
  return (
    <>
      <ZoomPressable
        containerStyle={{ flex: 1 }}
        testID="project-practice"
        accessibilityRole="button"
        accessibilityLabel={"Practice app. " + line}
        disabled={!project}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({ flex: 1, minHeight: 0, justifyContent: "center", borderRadius: 20, borderWidth: 1, borderColor: broken ? colors.statusAffected : colors.border, backgroundColor: pressed ? colors.surfaceRaised : colors.bg, padding, overflow: "hidden" })}
      >
        <View pointerEvents="none" style={{ position: "absolute", right: 18, top: 10, opacity: 0.14, transform: [{ rotate: "12deg" }] }}><Icon name="Zap" size={96} color="brandDeep" strokeWidth={1} /></View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="Zap" size={20} color={broken ? "statusAffected" : "brandDeep"} />
          <T variant="title">{broken ? "Broken" : "Break it"}</T>
          {short && <View style={{ flex: 1, alignItems: "flex-end" }}><Icon name="ArrowRight" size={18} color="textMuted" /></View>}
        </View>
        {!short && <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 12 }}><T color={broken ? "statusAffected" : "textMuted"} style={{ flex: 1 }} testID="project-practice-note">{line}</T><Icon name="ArrowRight" size={18} color="textMuted" /></View>}
      </ZoomPressable>
      {project && <PracticeSheet visible={open} onClose={() => setOpen(false)} project={project} />}
    </>
  );
}
