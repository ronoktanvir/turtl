import { StyleSheet, Text, View } from "react-native";
import type { CaseKind, RaisedBy } from "../../convex/constants";
import { kindLabel, RAISED_BY_LABELS } from "./cards";

export function CaseKindChip({
  kind,
  raisedBy,
  testIDPrefix,
}: {
  kind: CaseKind;
  raisedBy: RaisedBy;
  testIDPrefix: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.chip}>
        <Text style={styles.chipText} testID={`${testIDPrefix}-kind`}>
          {kindLabel(kind)}
        </Text>
      </View>
      <Text style={styles.raised} testID={`${testIDPrefix}-raised-by`}>
        Raised by {RAISED_BY_LABELS[raisedBy].toLowerCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#3C3C43",
    backgroundColor: "#F2F2F7",
  },
  chipText: { fontSize: 13, fontWeight: "600", color: "#111111" },
  raised: { fontSize: 13, color: "#555555" },
});
