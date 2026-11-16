import { useRef, useState } from "react";
import { View } from "react-native";
import { useAccountActions } from "../../data/account";
import { useTheme } from "../../theme";
import { Button, T } from "../ui";

/** What deleting an account removes, in the owner's words (checklist RC-23). convex/account/registry.ts is the list
 * the backend works through; keep the two in step. */
export const DELETED = [
  "Your projects, with every case, step, decision and message in them",
  "The map of your code",
  "Screenshots turtl took of your app",
  "The reports your customers sent",
  "What turtl remembers about past problems and your preferences",
  "turtl's access to your GitHub repositories",
  "Notifications on this phone and your other phones",
  "Your account and the ways you sign in to it",
] as const;

type Stage = "closed" | "explain" | "confirm";

/** Delete account, under Sign out in the account section. It says what goes, asks once more, then deletes and signs
 * out to Login. Only rendered for a signed-in account (AccountSection), so never in the demo or the example build. */
export default function DeleteAccount() {
  const { colors } = useTheme();
  const { deleteAccount } = useAccountActions();
  const [stage, setStage] = useState<Stage>("closed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const close = () => {
    setStage("closed");
    setError(null);
  };
  const remove = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const message = await deleteAccount();
    pending.current = false;
    setBusy(false);
    setError(message);
  };

  if (stage === "closed") return <Button label="Delete account" kind="danger" onPress={() => setStage("explain")} testID="account-delete" />;

  return (
    <View testID="account-delete-panel" style={{ gap: 12, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.statusAffected, backgroundColor: colors.surfaceRaised }}>
      <T variant="heading" accessibilityRole="header">Delete your account</T>
      {stage === "explain" ? (
        <>
          <T testID="account-delete-intro">Deleting your account removes all of this from turtl, and from the services turtl uses to keep it.</T>
          <View style={{ gap: 6 }} testID="account-delete-list">
            {DELETED.map((item, index) => (
              <View key={item} style={{ flexDirection: "row", gap: 8 }}>
                <T color="statusAffected">•</T>
                <T style={{ flex: 1 }} testID={`account-delete-item-${index}`}>{item}</T>
              </View>
            ))}
          </View>
          <T variant="strong" testID="account-delete-final">This can't be undone.</T>
          <Button label="Continue" kind="danger" onPress={() => setStage("confirm")} testID="account-delete-continue" />
          <Button label="Keep my account" kind="plain" onPress={close} testID="account-delete-cancel" />
        </>
      ) : (
        <>
          <T testID="account-delete-ask">Delete your account and everything in it now? You won't be able to get any of it back.</T>
          {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="account-delete-error">{error}</T>}
          <Button label={busy ? "Deleting…" : "Yes, delete my account"} kind="danger" disabled={busy} onPress={() => void remove()} testID="account-delete-confirm" />
          <Button label="Keep my account" kind="plain" disabled={busy} onPress={close} testID="account-delete-keep" />
        </>
      )}
    </View>
  );
}
