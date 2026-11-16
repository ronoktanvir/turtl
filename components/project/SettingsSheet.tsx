import { Pressable, View } from "react-native";
import { setApprovals } from "../../data";
import type { ApprovalMode } from "../../data/types";
import { useTheme, type ThemeMode } from "../../theme";
import { Button, Sheet, T } from "../ui";

function Choice({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      testID={testID}
      style={{
        flex: 1,
        minHeight: 48,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: selected ? colors.brandDeep : colors.border,
        backgroundColor: selected ? colors.brand : colors.surfaceRaised,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        paddingHorizontal: 8,
      }}
    >
      {selected && <T variant="strong" color="onBrand">✓</T>}
      <T variant="strong" color={selected ? "onBrand" : "text"}>
        {label}
      </T>
    </Pressable>
  );
}

const modes: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "dark", label: "Dark" },
  { mode: "light", label: "Light" },
];

export default function SettingsSheet({
  visible,
  onClose,
  projectId,
  approvals,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: string;
  approvals: ApprovalMode;
}) {
  const { mode, setMode } = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="Settings" testID="settings-sheet">
      <View style={{ gap: 8 }}>
        <T variant="heading">Who approves fixes</T>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Choice label="You" selected={approvals === "you"} onPress={() => setApprovals(projectId, "you")} testID="approvals-you" />
          <Choice label="Auto" selected={approvals === "auto"} onPress={() => setApprovals(projectId, "auto")} testID="approvals-auto" />
        </View>
        <T color="textMuted">
          {approvals === "you"
            ? "turtl waits for your approval before it changes any code."
            : "turtl applies the recommended fix on its own and tells you afterwards."}
        </T>
      </View>
      <View style={{ gap: 8 }}>
        <T variant="heading">Theme</T>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {modes.map((m) => (
            <Choice key={m.mode} label={m.label} selected={mode === m.mode} onPress={() => setMode(m.mode)} testID={`theme-${m.mode}`} />
          ))}
        </View>
      </View>
      <Button label="Done" onPress={onClose} testID="settings-done" />
    </Sheet>
  );
}
