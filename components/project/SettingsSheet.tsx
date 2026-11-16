import { useState } from "react";
import { Moon, Sun, UserRound, Zap, type LucideIcon } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { setApprovals } from "../../data";
import type { ApprovalMode } from "../../data/types";
import { useTheme, type ThemeMode } from "../../theme";
import { Button, Icon, Sheet, T } from "../ui";

function Choice({ label, selected, onPress, testID, icon: Symbol }: { label: string; selected: boolean; onPress: () => void; testID: string; icon: LucideIcon }) {
  const { colors } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="radio" aria-checked={selected} accessibilityState={{ checked: selected }} testID={testID} style={({ pressed }) => ({ flex: 1, minHeight: 64, borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.brandDeep : colors.surfaceRaised, backgroundColor: selected ? colors.brand : pressed ? colors.surface : colors.surfaceRaised, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 4 })}>
    <Symbol size={19} strokeWidth={1.7} color={selected ? colors.onBrand : colors.textMuted} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>{selected && <Icon name="Check" size={13} color="onBrand" />}<T variant="strong" color={selected ? "onBrand" : "textMuted"}>{label}</T></View>
  </Pressable>;
}

const modes: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [{ mode: "dark", label: "Dark", icon: Moon }, { mode: "light", label: "Light", icon: Sun }];

export default function SettingsSheet({ visible, onClose, projectId, approvals }: { visible: boolean; onClose: () => void; projectId: string; approvals: ApprovalMode }) {
  const { mode, setMode, colors } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const choose = async (value: ApprovalMode) => {
    setError(null);
    try { await setApprovals(projectId, value); } catch { setError("That preference could not be saved. Please try again."); }
  };
  return <Sheet visible={visible} onClose={onClose} title="Settings" testID="settings-sheet">
    <View style={{ gap: 12 }}>
      <T variant="heading">Who approves fixes</T>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 16, backgroundColor: colors.surfaceRaised }}>
        <Choice label="You" icon={UserRound} selected={approvals === "you"} onPress={() => void choose("you")} testID="approvals-you" />
        <Choice label="Auto" icon={Zap} selected={approvals === "auto"} onPress={() => void choose("auto")} testID="approvals-auto" />
      </View>
      <T color="textMuted">{approvals === "you" ? "You decide which fix goes ahead." : "Preference saved. You can still choose a fix below."}</T>
      {error && <T color="statusAffected" accessibilityRole="alert">{error}</T>}
    </View>
    <View style={{ gap: 12, marginTop: 8 }}>
      <T variant="heading">Theme</T>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 16, backgroundColor: colors.surfaceRaised }}>{modes.map((m) => <Choice key={m.mode} label={m.label} icon={m.icon} selected={mode === m.mode} onPress={() => setMode(m.mode)} testID={`theme-${m.mode}`} />)}</View>
    </View>
    <Button label="Done" onPress={onClose} testID="settings-done" />
  </Sheet>;
}
