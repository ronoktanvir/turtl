import { useRouter, type Href } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useAiPermission, useAiSpend, withdrawAi } from "../../data/consent";
import { Button, T } from "../ui";
import { spendLine, standingLine } from "./words";

// The gear sheet's AI section: where the permission stands, where the account stands against its limits, and the
// way to read the list again or take permission back. Shown only when the backend enforces it.
export default function AiSettings({ onClose }: { onClose: () => void }) {
  const status = useAiPermission();
  const spend = useAiSpend();
  const router = useRouter();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status?.enforced || !status.signedIn) return null;
  const allowed = status.services.some((service) => service.allowed);
  const open = () => {
    onClose();
    router.push("/ai-permission" as Href);
  };
  const withdraw = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await withdrawAi();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "turtl could not take the permission back. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 12 }} testID="ai-settings">
      <T variant="heading">AI services</T>
      <T color="textMuted" testID="ai-settings-standing">{busy ? "Taking permission back…" : standingLine(status)}</T>
      {spend?.enforced && <T variant="small" testID="ai-settings-spend">{spendLine(spend)}</T>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="Read the list" kind="outline" onPress={open} testID="ai-settings-read" style={{ flex: 1 }} />
        {allowed
          ? <Button label="Take back" kind="danger" disabled={busy} onPress={() => void withdraw()} testID="ai-settings-withdraw" style={{ flex: 1 }} />
          : <Button label="Allow" onPress={open} testID="ai-settings-allow" style={{ flex: 1 }} />}
      </View>
      {error && <T color="statusAffected" accessibilityRole="alert">{error}</T>}
    </View>
  );
}
