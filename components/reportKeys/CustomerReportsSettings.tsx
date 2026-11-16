import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { makeReportKey, revokeReportKey, useReportKeys, type ReportKey } from "../../data/reportKeys";
import { useTheme } from "../../theme";
import { Button, Icon, T, ago } from "../ui";

const FORM_GUIDE = "https://github.com/ronoktanvir/turtl/blob/main/protected-app/report/README.md";

// The project's Settings row for its customers' report form: make a report key (shown whole once), see when each key
// was made, and revoke one. A key only names the project in the form; it is not a secret.
export default function CustomerReportsSettings({ projectId }: { projectId: string }) {
  const keys = useReportKeys(projectId);
  const { colors } = useTheme();
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ReportKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  if (keys === null) return null;

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "That did not work. Try again.", problem: true });
    } finally {
      setBusy(false);
    }
  };
  const make = () => run(async () => setFresh(await makeReportKey(projectId)));
  const revoke = (key: ReportKey) =>
    run(async () => {
      await revokeReportKey(key.id);
      setRevoking(null);
      setMessage({ text: "The key ending " + key.ending + " is revoked. Reports sent with it no longer arrive.", problem: false });
    });

  return (
    <View style={{ gap: 12 }} testID="customer-reports-settings">
      <T variant="heading">Customer reports</T>
      <T>Your customers can tell turtl when something is wrong, through a small form in your app. The form needs a report key, which names this project. It is not a secret.</T>
      {fresh ? (
        <View style={{ gap: 10, borderWidth: 1, borderColor: colors.brandDeep, borderRadius: 16, padding: 16 }} testID="customer-reports-new-key">
          <T variant="strong">Your new report key</T>
          <T variant="mono" selectable testID="customer-reports-new-key-value">{fresh}</T>
          <T color="textMuted">Copy it now: turtl shows the whole key only this once.</T>
          <Button label="Done" kind="outline" onPress={() => setFresh(null)} testID="customer-reports-new-key-done" />
        </View>
      ) : (
        <Button label={busy ? "Making a key…" : "Make a report key"} kind="outline" disabled={busy || keys === undefined} onPress={() => void make()} testID="customer-reports-make" />
      )}
      {keys === undefined ? (
        <T color="textMuted">Checking report keys…</T>
      ) : keys.length === 0 ? (
        <T color="textMuted" testID="customer-reports-none">No report keys yet.</T>
      ) : (
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
          {keys.map((key, index) => (
            <View key={key.id} style={{ gap: 10, padding: 14, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }} testID={"customer-reports-key-" + index}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="strong">{"Key ending " + key.ending}</T>
                  <T variant="small" color="textMuted">{"Made " + ago(key.createdAt)}</T>
                </View>
                {revoking?.id !== key.id && (
                  <Button label="Revoke" kind="danger" disabled={busy} onPress={() => { setRevoking(key); setMessage(null); }} testID={"customer-reports-revoke-" + index} style={{ minHeight: 44, paddingHorizontal: 14 }} />
                )}
              </View>
              {revoking?.id === key.id && (
                <View style={{ gap: 10 }} testID={"customer-reports-revoke-confirm-" + index}>
                  <T>{"Revoke the key ending " + key.ending + "? Reports sent with it stop arriving. Reports turtl already received stay."}</T>
                  <Button label={busy ? "Revoking…" : "Revoke key"} kind="danger" disabled={busy} onPress={() => void revoke(key)} testID={"customer-reports-revoke-confirm-button-" + index} />
                  <Button label="Keep it" kind="plain" disabled={busy} onPress={() => setRevoking(null)} testID={"customer-reports-revoke-cancel-" + index} />
                </View>
              )}
            </View>
          ))}
        </View>
      )}
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(FORM_GUIDE)} testID="customer-reports-guide" style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="ExternalLink" size={15} color="link" />
        <T color="link" style={{ flex: 1 }}>How to add the report form to your app</T>
      </Pressable>
      {message && (
        <T font="text" color={message.problem ? "statusAffected" : "text"} accessibilityRole={message.problem ? "alert" : undefined} testID="customer-reports-message">
          {message.text}
        </T>
      )}
    </View>
  );
}
