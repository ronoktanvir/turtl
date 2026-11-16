import { useState } from "react";
import { TextInput, View } from "react-native";
import { cancelOwnerPasscode, submitOwnerPasscode, useOwnerPasscodePrompt } from "../../data/live/ownerPasscode";
import { useTheme } from "../../theme";
import { Button, Sheet, T } from ".";

export default function OwnerPasscodePrompt() {
  const prompt = useOwnerPasscodePrompt();
  const { colors } = useTheme();
  const [passcode, setPasscode] = useState("");
  if (!prompt) return null;
  const close = () => { cancelOwnerPasscode(); setPasscode(""); };
  const submit = async () => {
    const value = passcode;
    setPasscode("");
    await submitOwnerPasscode(value);
  };
  return <Sheet visible onClose={close} title="Owner passcode" testID="owner-passcode-sheet">
    <T>Enter your passcode to make this decision. It stays on this device for your next decision.</T>
    <View style={{ gap: 12 }}>
      <TextInput autoFocus secureTextEntry autoCapitalize="none" autoCorrect={false} value={passcode} onChangeText={setPasscode} editable={!prompt.busy} accessibilityLabel="Owner passcode" testID="owner-passcode-input" onSubmitEditing={() => { if (passcode && !prompt.busy) void submit(); }} style={{ color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16, fontFamily: "Capriola_400Regular", fontWeight: "400" }} />
      {prompt.error && <T color="statusAffected" accessibilityRole="alert" testID="owner-passcode-error">{prompt.error}</T>}
      <Button label={prompt.busy ? "Checking…" : "Continue"} disabled={!passcode || prompt.busy} onPress={() => void submit()} testID="owner-passcode-continue" />
      <Button label="Cancel" kind="plain" disabled={prompt.busy} onPress={close} testID="owner-passcode-cancel" />
    </View>
  </Sheet>;
}
