import { useRef, useState } from "react";
import { Moon, Sun, UserRound, Zap, type LucideIcon } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { isLiveData, setApprovals, useApprovalSettings } from "../../data";
import type { ApprovalMode } from "../../data/types";
import { useTheme, type ThemeMode } from "../../theme";
import { Button, Icon, Sheet, T } from "../ui";
import LegalLinks from "../legal/LegalLinks";
import AccountSection from "../account/AccountSection";
import OwnerPasscodeSettings from "./OwnerPasscodeSettings";
import PreferencesSettings from "./PreferencesSettings";

function Choice({ label, selected, disabled, onPress, testID, icon: Symbol }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void; testID: string; icon: LucideIcon }) {
  const { colors } = useTheme();
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="radio" aria-checked={selected} accessibilityState={{ checked: selected, disabled: !!disabled }} testID={testID} style={({ pressed }) => ({ flex: 1, minHeight: 64, borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.brandDeep : colors.surfaceRaised, backgroundColor: selected ? colors.brand : pressed ? colors.surface : colors.surfaceRaised, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 4, opacity: disabled ? 0.65 : 1 })}>
    <Symbol size={19} strokeWidth={1.7} color={selected ? colors.onBrand : colors.textMuted} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>{selected && <Icon name="Check" size={13} color="onBrand" />}<T variant="strong" color={selected ? "onBrand" : "textMuted"}>{label}</T></View>
  </Pressable>;
}

const modes: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [{ mode: "dark", label: "Dark", icon: Moon }, { mode: "light", label: "Light", icon: Sun }];

export default function SettingsSheet({ visible, onClose, projectId }: { visible: boolean; onClose: () => void; projectId: string }) {
  const { mode, setMode, colors } = useTheme();
  const settings = useApprovalSettings(projectId);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (value: ApprovalMode) => {
    if (pending.current || settings.loading || (value === "auto" && !settings.canEnable) || (value === "auto") === settings.active) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await setApprovals(projectId, value);
    } catch (error) {
      setError(error instanceof Error ? error.message : "That permission could not be changed. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <Sheet visible={visible} onClose={onClose} title="Settings" testID="settings-sheet">
    <View style={{ gap: 12 }}>
      <T variant="heading">Who approves fixes</T>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 16, backgroundColor: colors.surfaceRaised }}>
        <Choice label="You" icon={UserRound} selected={!settings.active} disabled={settings.loading || busy} onPress={() => void choose("you")} testID="approvals-you" />
        <Choice label="Auto" icon={Zap} selected={settings.active} disabled={settings.loading || busy || (!settings.active && !settings.canEnable)} onPress={() => void choose("auto")} testID="approvals-auto" />
      </View>
      <T color="textMuted">{busy ? "Updating permission…" : settings.loading ? "Checking permission…" : settings.reason}</T>
      {settings.scope && <T testID="approvals-scope">{settings.scope}</T>}
      <T color="textMuted">Each Auto permission permits one action with its pinned values, bound to this app version, for at most 3 uses. It requires 2 verified recoveries. Every other fix still needs your approval.</T>
      {error && <T color="statusAffected" accessibilityRole="alert">{error}</T>}
    </View>
    <PreferencesSettings projectId={projectId} />
    {isLiveData && visible && <OwnerPasscodeSettings />}
    <View style={{ gap: 12, marginTop: 8 }}>
      <T variant="heading">Theme</T>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 16, backgroundColor: colors.surfaceRaised }}>{modes.map((m) => <Choice key={m.mode} label={m.label} icon={m.icon} selected={mode === m.mode} onPress={() => setMode(m.mode)} testID={`theme-${m.mode}`} />)}</View>
    </View>
    <AccountSection />
    {isLiveData && <LegalLinks />}
    <Button label="Done" onPress={onClose} testID="settings-done" />
  </Sheet>;
}
