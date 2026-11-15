import { useMutation } from "convex/react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CARD_STATUS_COLORS } from "./cards";

// Grant and Revoke only ask; the confirmation is what calls the permission mutation.
export function PermissionPanel(
  props: { kind: "grant"; memoryId: Id<"recoveryMemories"> } | { kind: "revoke"; permissionId: Id<"permissions"> },
) {
  const grant = useMutation(api.permissions.grant);
  const revoke = useMutation(api.permissions.revoke);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granting = props.kind === "grant";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (props.kind === "grant") await grant({ memoryId: props.memoryId });
      else await revoke({ permissionId: props.permissionId });
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel} testID="permission-panel">
      {!confirming ? (
        <Button
          testID={granting ? "permission-grant" : "permission-revoke"}
          label={granting ? "Let turtl run this on its own" : "Revoke permission"}
          color={granting ? CARD_STATUS_COLORS.done : CARD_STATUS_COLORS.failed}
          onPress={() => setConfirming(true)}
        />
      ) : (
        <View style={styles.confirm}>
          <Text style={styles.question} testID="permission-confirm-question">
            {granting
              ? "Let turtl run this one recovery without asking you, under the rules above?"
              : "Revoke this permission? turtl will ask you before running this recovery again."}
          </Text>
          <View style={styles.row}>
            <Button
              testID={granting ? "permission-grant-confirm" : "permission-revoke-confirm"}
              label={granting ? "Yes, allow it" : "Yes, revoke"}
              color={granting ? CARD_STATUS_COLORS.done : CARD_STATUS_COLORS.failed}
              disabled={busy}
              onPress={confirm}
            />
            <Button
              testID="permission-confirm-cancel"
              label="Cancel"
              color={CARD_STATUS_COLORS.pending}
              disabled={busy}
              onPress={() => setConfirming(false)}
            />
          </View>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function Button(props: { testID: string; label: string; color: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, { backgroundColor: props.color }, props.disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 10, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#C7C7CC" },
  row: { flexDirection: "row", gap: 12 },
  confirm: { gap: 10 },
  question: { fontSize: 16, fontWeight: "600", color: "#111111" },
  button: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  disabled: { opacity: 0.5 },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  error: { fontSize: 14, color: CARD_STATUS_COLORS.failed },
});
