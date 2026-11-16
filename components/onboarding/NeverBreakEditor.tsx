import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type { NeverBreakAnswer } from "../../data/onboarding/types";
import { useTheme } from "../../theme";
import { Button, Chip, Icon, T } from "../ui";
import { Toggle } from "../ui/Toggle";

export function NeverBreakEditor({ answers, editable, onChange }: { answers: NeverBreakAnswer[]; editable: boolean; onChange: (next: NeverBreakAnswer[]) => void }) {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const add = () => {
    const value = text.trim();
    if (!value) return;
    onChange([...answers, { text: value, suggested: false, addCheck: true }]);
    setText("");
  };
  return (
    <View style={{ gap: 12 }}>
      {answers.length === 0 && <T color="textMuted">{editable ? "No suggestions yet. Add what matters most to your customers." : "No answers were given."}</T>}
      {answers.map((answer, index) => (
        <View key={answer.id ?? "new-" + index} testID={"never-break-" + index} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: answer.addCheck ? colors.brandDeep : colors.border, backgroundColor: colors.surface }}>
          <View style={{ flex: 1, gap: 6 }}>
            <T variant="strong">{answer.text}</T>
            {answer.suggested && <Chip label="Suggested" tone="statusClear" />}
            {answer.why && <T variant="small" color="textMuted">{answer.why}</T>}
          </View>
          {!editable ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} testID={"never-break-" + index + "-decision"}>
              <Icon name={answer.addCheck ? "Check" : "X"} size={16} color={answer.addCheck ? "statusClear" : "textMuted"} />
              <T variant="small" color={answer.addCheck ? "statusClear" : "textMuted"}>{answer.addCheck ? "Check added" : "No check"}</T>
            </View>
          ) : (
            <Toggle
              label="Add a check"
              value={answer.addCheck}
              onChange={(addCheck) => onChange(answers.map((a, i) => (i === index ? { ...a, addCheck } : a)))}
              accessibilityLabel={"Add a check: " + answer.text}
              testID={"never-break-" + index + "-check"}
            />
          )}
          {editable && !answer.suggested && (
            <Pressable accessibilityRole="button" accessibilityLabel={"Remove " + answer.text} onPress={() => onChange(answers.filter((_, i) => i !== index))} style={{ width: 44, height: 44, marginRight: -8, alignItems: "center", justifyContent: "center" }}>
              <Icon name="X" size={18} color="textMuted" />
            </Pressable>
          )}
        </View>
      ))}
      {editable && (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={add}
            placeholder="Add your own"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Something that must never break"
            testID="never-break-input"
            style={{ flex: 1, color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16, fontFamily: "Capriola_400Regular" }}
          />
          <Button label="Add" icon="Plus" kind="outline" disabled={!text.trim()} onPress={add} testID="never-break-add" />
        </View>
      )}
    </View>
  );
}
