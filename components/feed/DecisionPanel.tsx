import { useMutation } from "convex/react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CARD_STATUS_COLORS } from "./cards";

// Approve and Decline only ask; the confirmation is what calls the decision mutation.
export function DecisionPanel({
  proposalId,
  version,
  optionKey,
  optionTitle,
}: {
  proposalId: Id<"proposals">;
  version: number;
  optionKey: string;
  optionTitle: string;
}) {
  const approve = useMutation(api.decisions.approve);
  const decline = useMutation(api.decisions.decline);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (confirming === "approve") await approve({ proposalId, version, optionKey });
      else if (confirming === "decline") await decline({ proposalId, version });
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision was not recorded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel} testID="case-decision">
      {confirming === null ? (
        <View style={styles.row}>
          <Button testID="case-approve" label="Approve" color={CARD_STATUS_COLORS.done} onPress={() => setConfirming("approve")} />
          <Button testID="case-decline" label="Decline" color={CARD_STATUS_COLORS.pending} onPress={() => setConfirming("decline")} />
        </View>
      ) : (
        <View style={styles.confirm}>
          <Text style={styles.question} testID="case-confirm-question">
            {confirming === "approve"
              ? `Run "${optionTitle}" on your app now?`
              : "Decline this recommendation? Nothing will be changed, and this case will close."}
          </Text>
          <View style={styles.row}>
            <Button
              testID={confirming === "approve" ? "case-approve-confirm" : "case-decline-confirm"}
              label={confirming === "approve" ? "Yes, approve" : "Yes, decline"}
              color={confirming === "approve" ? CARD_STATUS_COLORS.done : CARD_STATUS_COLORS.failed}
              disabled={busy}
              onPress={confirm}
            />
            <Button testID="case-confirm-cancel" label="Cancel" color={CARD_STATUS_COLORS.pending} disabled={busy} onPress={() => setConfirming(null)} />
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
