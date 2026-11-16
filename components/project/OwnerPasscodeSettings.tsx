import { useState } from "react";
import { TextInput, View } from "react-native";
import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient, useLiveQuery } from "../../data/live/client";
import { storeOwnerPasscode } from "../../data/live/ownerPasscode";
import { useTheme } from "../../theme";
import { Button, T } from "../ui";

export default function OwnerPasscodeSettings() {
  const status = useLiveQuery(api.ownerPasscode.status, {});
  const { colors } = useTheme();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputStyle = { color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16 };
  const save = async () => {
    if (busy) return;
    if (next !== confirm) { setMessage("The new passcodes do not match."); return; }
    setBusy(true);
    setMessage(null);
    try {
      await requireLiveClient().mutation(api.ownerPasscode.set, { passcode: next, ...(status?.configured && { currentPasscode: current }) });
      try {
        await storeOwnerPasscode(next);
        setMessage("Owner passcode saved on this device.");
      } catch {
        setMessage("The owner passcode was set, but this device could not save it. Enter it again at your next decision.");
      }
      setCurrent(""); setNext(""); setConfirm(""); setEditing(false);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <View style={{ gap: 12 }} testID="owner-passcode-settings">
    <T variant="heading">Owner passcode</T>
    <T color={status?.configured ? "textMuted" : "statusAffected"} testID="owner-passcode-status">{status === undefined ? "Checking owner passcode…" : status.configured ? "A passcode protects owner decisions across all projects. Read-only screens stay open." : "No owner passcode is set. Anyone with the backend address can make decisions. Linking and merging pull requests are blocked until you set one."}</T>
    {!editing ? <Button label={status?.configured ? "Change owner passcode" : "Set owner passcode"} kind="outline" disabled={!status} onPress={() => { setEditing(true); setMessage(null); }} testID="owner-passcode-edit" /> : <>
      {status?.configured && <TextInput accessibilityLabel="Current owner passcode" testID="owner-passcode-current" secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Current passcode" placeholderTextColor={colors.textMuted} value={current} onChangeText={setCurrent} editable={!busy} style={inputStyle} />}
      <TextInput accessibilityLabel="New owner passcode" testID="owner-passcode-new" secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="New passcode (at least 8 characters)" placeholderTextColor={colors.textMuted} value={next} onChangeText={setNext} editable={!busy} style={inputStyle} />
      <TextInput accessibilityLabel="Confirm new owner passcode" testID="owner-passcode-confirm" secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Confirm new passcode" placeholderTextColor={colors.textMuted} value={confirm} onChangeText={setConfirm} editable={!busy} style={inputStyle} />
      <T variant="small" color="textMuted">Use a unique, hard-to-guess passcode. Only its hash is stored on the backend. This device remembers it; in a browser, it is kept in this site's local storage.</T>
      <Button label={busy ? "Saving…" : "Save owner passcode"} disabled={busy || next.length < 8 || !confirm || (!!status?.configured && !current)} onPress={() => void save()} testID="owner-passcode-save" />
      <Button label="Cancel change" kind="plain" disabled={busy} onPress={() => { setEditing(false); setCurrent(""); setNext(""); setConfirm(""); setMessage(null); }} testID="owner-passcode-cancel-change" />
    </>}
    {message && <T accessibilityRole="alert" testID="owner-passcode-settings-message">{message}</T>}
  </View>;
}
