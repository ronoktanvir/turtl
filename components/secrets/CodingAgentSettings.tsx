import { useState } from "react";
import { View } from "react-native";
import { removeCodingAgentKey, saveCodingAgentKey, useCodingAgent } from "../../data/secrets";
import { useTheme } from "../../theme";
import { Button, T, ago } from "../ui";
import { SecretInput } from "./SecretInput";

// The gear sheet's Coding agent row: the account's own Capy key, which every code change and project preparation
// starts with. It shows only with accounts on; the single-owner demo's backend uses its own key.
export default function CodingAgentSettings() {
  const status = useCodingAgent();
  const { colors } = useTheme();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  if (!status?.accounts || !status.signedIn) return null;

  const showInput = !status.set || editing;
  const run = async (work: () => Promise<void>, done: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setApiKey("");
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
    <View style={{ gap: 12 }} testID="coding-agent-settings">
      <T variant="heading">Coding agent</T>
      <T>turtl writes code changes and prepares projects with your own Capy account. It keeps your Capy API key encrypted, never shows it again, and uses it only for work you approve.</T>
      {status.set ? (
        <T color="textMuted" testID="coding-agent-status">{"Connected " + (status.setAt ? ago(status.setAt) : "") + "."}</T>
      ) : (
        <>
          <T color="textMuted" testID="coding-agent-status">Not connected. Code changes and preparing a project wait until you connect it. Watching your app, finding the cause, recoveries and merging pull requests work without it.</T>
          <T color="textMuted">Your API key is in Capy (capy.ai), in your account's settings.</T>
        </>
      )}
      {showInput ? (
        <>
          <SecretInput label="Capy API key" placeholder="Paste your Capy API key" value={apiKey} onChangeText={setApiKey} editable={!busy} testID="coding-agent-input" />
          <Button label={busy ? "Connecting…" : "Connect coding agent"} disabled={busy || apiKey.trim().length === 0} onPress={() => void run(() => saveCodingAgentKey(apiKey), "Your coding agent is connected.")} testID="coding-agent-save" />
          {status.set && <Button label="Keep the saved key" kind="plain" disabled={busy} onPress={() => { setEditing(false); setApiKey(""); }} testID="coding-agent-cancel" />}
        </>
      ) : confirming ? (
        <View style={{ gap: 12, borderWidth: 1, borderColor: colors.statusAffected, borderRadius: 16, padding: 16 }} testID="coding-agent-disconnect-confirm">
          <T variant="strong">Disconnect your coding agent?</T>
          <T>turtl starts no new code change or preparation until you connect it again. Work already started keeps running in Capy.</T>
          <Button label={busy ? "Disconnecting…" : "Disconnect"} kind="danger" disabled={busy} onPress={() => void run(() => removeCodingAgentKey(), "Your coding agent is disconnected. turtl no longer holds its key.")} testID="coding-agent-disconnect-confirm-button" />
          <Button label="Keep connected" kind="plain" disabled={busy} onPress={() => setConfirming(false)} testID="coding-agent-disconnect-cancel" />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Button label="Replace key" kind="outline" disabled={busy} onPress={() => { setEditing(true); setMessage(null); }} testID="coding-agent-replace" />
          <Button label="Disconnect coding agent" kind="danger" disabled={busy} onPress={() => { setConfirming(true); setMessage(null); }} testID="coding-agent-disconnect" />
        </View>
      )}
      {message && (
        <T color={message.problem ? "statusAffected" : "text"} accessibilityRole={message.problem ? "alert" : undefined} testID="coding-agent-message">
          {message.text}
        </T>
      )}
    </View>
  );
}
