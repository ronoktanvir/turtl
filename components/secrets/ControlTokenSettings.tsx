import { useState } from "react";
import { View } from "react-native";
import { removeControlToken, saveControlToken, useControlToken } from "../../data/secrets";
import { useTheme } from "../../theme";
import { Button, Icon, T, ago } from "../ui";
import { SecretInput } from "./SecretInput";

// A project's control token: in the project's Settings and on its Preparation screen. It shows only with accounts on;
// the single-owner demo's backend holds its own token, so there it draws nothing.
export default function ControlTokenSettings({ projectId, testID = "control-token" }: { projectId: string; testID?: string }) {
  const status = useControlToken(projectId);
  const { colors } = useTheme();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  if (!status?.accounts) return null;

  const where = status.sendsTo ?? "this project's live address";
  const showInput = !status.set || editing;
  const run = async (work: () => Promise<void>, done: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setToken("");
      setEditing(false);
      setConfirming(false);
      setMessage({ text: done, problem: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "That did not work. Try again.", problem: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }} testID={testID}>
      <T variant="heading">Control token</T>
      <T>{"Your app's checks and switches answer only to this token. turtl sends it only to " + where + ", and never shows it to anyone again, you included."}</T>
      {status.set ? (
        <T color="textMuted" testID={testID + "-status"}>{"Saved " + (status.setAt ? ago(status.setAt) : "") + ". turtl uses it for every check and switch on this project."}</T>
      ) : (
        <T color="textMuted" testID={testID + "-status"}>{"Not set yet. The preparation pull request explains how to make one and where your app keeps it. Paste the same token here."}</T>
      )}
      {status.notWatched && (
        <View style={{ flexDirection: "row", gap: 10, padding: 14, borderRadius: 16, backgroundColor: colors.surfaceRaised }}>
          <Icon name="TriangleAlert" size={18} color="statusNeedsYou" />
          <T style={{ flex: 1 }} testID={testID + "-not-watched"}>{status.notWatched}</T>
        </View>
      )}
      {showInput ? (
        <>
          <SecretInput label="Control token" placeholder="Paste your app's control token" value={token} onChangeText={setToken} editable={!busy} testID={testID + "-input"} />
          <Button label={busy ? "Saving…" : "Save token"} disabled={busy || token.trim().length === 0} onPress={() => void run(() => saveControlToken(projectId, token), "Token saved. turtl will use it from the next check.")} testID={testID + "-save"} />
          {status.set && <Button label="Keep the saved token" kind="plain" disabled={busy} onPress={() => { setEditing(false); setToken(""); }} testID={testID + "-cancel"} />}
        </>
      ) : confirming ? (
        <View style={{ gap: 12, borderWidth: 1, borderColor: colors.statusAffected, borderRadius: 16, padding: 16 }} testID={testID + "-remove-confirm"}>
          <T variant="strong">Remove the control token?</T>
          <T>turtl stops running this project's checks and switches that need it until you add one again.</T>
          <Button label={busy ? "Removing…" : "Remove token"} kind="danger" disabled={busy} onPress={() => void run(() => removeControlToken(projectId), "Token removed. turtl no longer holds it.")} testID={testID + "-remove-confirm-button"} />
          <Button label="Keep it" kind="plain" disabled={busy} onPress={() => setConfirming(false)} testID={testID + "-remove-cancel"} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Button label="Replace token" kind="outline" disabled={busy} onPress={() => { setEditing(true); setMessage(null); }} testID={testID + "-replace"} />
          <Button label="Remove token" kind="danger" disabled={busy} onPress={() => { setConfirming(true); setMessage(null); }} testID={testID + "-remove"} />
        </View>
      )}
      {message && (
        <T color={message.problem ? "statusAffected" : "text"} accessibilityRole={message.problem ? "alert" : undefined} testID={testID + "-message"}>
          {message.text}
        </T>
      )}
    </View>
  );
}
