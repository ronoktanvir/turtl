import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CaseKind, CaseStatus, RaisedBy } from "../../convex/constants";
import { CASE_STATUS_COLORS, CASE_STATUS_LABELS, timeAgo, type FeedStep } from "./cards";
import { CaseKindChip } from "./CaseKindChip";
import { ProgressStrip } from "./ProgressStrip";
import { StatusBadge } from "./StatusBadge";

export function CaseRow({
  item,
  now,
}: {
  item: {
    _id: string;
    _creationTime: number;
    title: string;
    kind: CaseKind;
    raisedBy: RaisedBy;
    status: CaseStatus;
    steps: FeedStep[];
  };
  now: number;
}) {
  return (
    <Link href={{ pathname: "/case/[id]", params: { id: item._id } }} asChild>
      <Pressable style={styles.row} testID="case-row" accessibilityRole="button">
        <Text style={styles.title} testID="case-row-title">
          {item.title}
        </Text>
        <CaseKindChip kind={item.kind} raisedBy={item.raisedBy} testIDPrefix="case-row" />
        <View style={styles.meta}>
          <StatusBadge
            label={CASE_STATUS_LABELS[item.status]}
            color={CASE_STATUS_COLORS[item.status]}
            testID="case-row-status"
          />
          <Text style={styles.ago} testID="case-row-started">
            Started {timeAgo(item._creationTime, now)}
          </Text>
        </View>
        <ProgressStrip steps={item.steps} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 10,
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#C7C7CC",
    backgroundColor: "#FFFFFF",
  },
  title: { fontSize: 17, fontWeight: "600", color: "#111111" },
  meta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ago: { fontSize: 14, color: "#555555" },
});
