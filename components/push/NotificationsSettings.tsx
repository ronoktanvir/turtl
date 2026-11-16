import { Bell, BellOff } from "lucide-react-native";
import { View } from "react-native";
import { PUSH_EXPLAINED, usePush, type PushKind } from "../../data/push";
import { useTheme } from "../../theme";
import { Button, T } from "../ui";

const statusLine: Record<Exclude<PushKind, "hidden">, string> = {
  loading: "Checking notifications…",
  unsupported: "Notifications work in the turtl app on your phone, not in a browser.",
  signed_out: "Sign in to turn on notifications for this phone.",
  blocked: "Notifications for turtl are off in your phone's settings. Everything else still works.",
  off: "Off for this phone.",
  on: "On for this phone.",
};

/** The Notifications row in the gear sheet. Not shown in the demo or the example build. */
export default function NotificationsSettings() {
  const push = usePush();
  const { colors } = useTheme();
  if (push.kind === "hidden") return null;
  const Symbol = push.kind === "on" ? Bell : BellOff;
  return (
    <View style={{ gap: 12 }} testID="notifications-settings">
      <T variant="heading">Notifications</T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Symbol size={18} strokeWidth={1.7} color={push.kind === "on" ? colors.text : colors.textMuted} />
        <T variant="strong" testID="notifications-status" style={{ flex: 1 }}>{statusLine[push.kind]}</T>
      </View>
      <T color="textMuted">{PUSH_EXPLAINED}</T>
      {push.kind === "off" && (
        <Button label={push.busy ? "Turning on…" : "Turn on notifications"} disabled={push.busy} onPress={() => void push.turnOn()} testID="notifications-turn-on" />
      )}
      {push.kind === "on" && (
        <Button label={push.busy ? "Turning off…" : "Turn off on this phone"} kind="plain" disabled={push.busy} onPress={() => void push.turnOff()} testID="notifications-turn-off" />
      )}
      {push.kind === "blocked" && (
        <Button label="Open phone settings" kind="outline" onPress={() => void push.openSettings()} testID="notifications-open-settings" />
      )}
      {push.message && <T accessibilityRole="alert" testID="notifications-message">{push.message}</T>}
    </View>
  );
}
