import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { addPreference, confirmPreference, dismissPreference, removePreference, usePreferences } from "../../data";
import type { PreferenceSuggestion } from "../../data/types";
import { useTheme } from "../../theme";
import { Button, Icon, T } from "../ui";
import { SkeletonLines } from "../ui/Skeleton";

const heardFrom: Record<PreferenceSuggestion["source"], string> = {
  decision_note: "From your note on a decision",
  chat: "From Investigate further",
};

export default function PreferencesSettings({ projectId }: { projectId: string }) {
  const { colors } = useTheme();
  const data = usePreferences(projectId);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>, onDone?: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : "That change could not be saved. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const add = () => {
    const statement = draft.trim();
    if (statement) void run(() => addPreference(projectId, statement), () => setDraft(""));
  };
  return (
    <View style={{ gap: 12 }} testID="preferences-section">
      <T variant="heading">What matters to you</T>
      <T color="textMuted">turtl weighs these when it recommends a fix. They are never treated as evidence and never approve anything.</T>
      {data === undefined && <SkeletonLines lines={2} testID="preferences-loading" />}
      {data === null && <T color="textMuted">Preferences are not available for this project.</T>}
      {data?.preferences.length === 0 && <T color="textMuted" testID="preferences-empty">Nothing saved yet.</T>}
      {data?.preferences.map((preference) => (
        <View key={preference.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderLeftWidth: 2, borderLeftColor: colors.brandDeep, paddingLeft: 12 }} testID={"preference-" + preference.id}>
          <T font="text" style={{ flex: 1 }}>{preference.statement}</T>
          <Pressable onPress={() => void run(() => removePreference(projectId, preference.id))} disabled={busy} accessibilityRole="button" accessibilityLabel="Remove preference" testID={"preference-remove-" + preference.id} hitSlop={6} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}>
            <Icon name="X" size={18} color="textMuted" />
          </Pressable>
        </View>
      ))}
      {data && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={add}
            editable={!busy}
            maxLength={200}
            placeholder="Keep checkout up"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Add what matters to you"
            returnKeyType="done"
            testID="preference-input"
            style={{ flex: 1, minWidth: 0, minHeight: 48, color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, fontFamily: "Capriola_400Regular" }}
          />
          <Button label="Add" kind="outline" disabled={busy || !draft.trim()} onPress={add} testID="preference-add" />
        </View>
      )}
      {!!data?.suggestions.length && (
        <View style={{ gap: 12, marginTop: 4 }}>
          <T variant="strong">turtl heard</T>
          {data.suggestions.map((suggestion) => (
            <View key={suggestion.id} style={{ gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised }} testID={"suggestion-" + suggestion.id}>
              <T font="text">{"“" + suggestion.statement + "”"}</T>
              <T variant="small" color="textMuted">{heardFrom[suggestion.source]}</T>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label="Save" disabled={busy} onPress={() => void run(() => confirmPreference(projectId, suggestion.id))} testID={"suggestion-save-" + suggestion.id} style={{ flex: 1, minHeight: 44 }} />
                <Button label="Dismiss" kind="plain" disabled={busy} onPress={() => void run(() => dismissPreference(projectId, suggestion.id))} testID={"suggestion-dismiss-" + suggestion.id} style={{ flex: 1, minHeight: 44 }} />
              </View>
            </View>
          ))}
        </View>
      )}
      {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="preferences-error">{error}</T>}
    </View>
  );
}
