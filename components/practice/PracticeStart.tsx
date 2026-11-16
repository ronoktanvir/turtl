import { useRouter, type Href } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";
import { createPractice, usePractice } from "../../data/practice";
import { useTheme } from "../../theme";
import { Button, T } from "../ui";

// The way to a practice app, for someone with no repository to hand: on the first-run screen and on Add project. It
// draws nothing where there are no practice apps (the single-owner demo) or while that is not known yet. An account
// that already has one is taken to it: asking again never makes a second.

export default function PracticeStart({ testID, card = false, disabled = false }: { testID: string; card?: boolean; disabled?: boolean }) {
  const practice = usePractice();
  const router = useRouter();
  const { colors } = useTheme();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!practice || (!practice.available && !practice.project)) return null;
  const has = practice.project !== null;

  const open = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const { projectId } = await createPractice();
      router.push(("/project/" + projectId) as Href);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "turtl could not set up your practice app. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const button = (
    <Button
      label={busy ? "Setting it up…" : has ? "Open practice app" : "Try a practice app"}
      kind="outline"
      icon="Zap"
      disabled={busy || disabled}
      onPress={() => void open()}
      testID={testID + "-button"}
      style={{ minHeight: 52, borderRadius: 16 }}
    />
  );
  const what = "turtl runs a small booking app for you. Break it on purpose and watch turtl find the problem and fix it.";
  const explain = has ? "Your practice app is the booking app turtl runs for you. Break it on purpose and watch turtl fix it." : card ? what : "No repository to hand? " + what;

  return (
    <View testID={testID} style={card ? { gap: 12, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface } : { gap: 10 }}>
      {card && <T variant="heading">{has ? "Your practice app" : "No repository to hand"}</T>}
      {card && <T color="textMuted">{explain}</T>}
      {button}
      {!card && <T variant="small" color="textMuted" style={{ textAlign: "center" }}>{explain}</T>}
      {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID={testID + "-error"}>{error}</T>}
    </View>
  );
}
