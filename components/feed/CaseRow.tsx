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
    impact: string;
    kind: CaseKind;
    raisedBy: RaisedBy;
    status: CaseStatus;
    steps: FeedStep[];
    handledUnderPermission?: boolean;
  };
  now: number;
}) {
  return (
    <Link href={{ pathname: "/case/[id]", params: { id: item._id } }} asChild>
      <Pressable style={styles.row} testID="case-row" accessibilityRole="button">
        {item.status === "waiting_for_owner" && (
          <Text style={[styles.needsYou, { color: CASE_STATUS_COLORS.waiting_for_owner }]} testID="case-row-needs-you">
            Needs your decision
          </Text>
        )}
        {item.handledUnderPermission && (
          <Text style={[styles.needsYou, { color: CASE_STATUS_COLORS.restored }]} testID="case-row-auto">
            Handled under your permission
          </Text>
        )}
        <Text style={styles.title} testID="case-row-title">
          {item.title}
        </Text>
        <Text style={styles.impact} numberOfLines={1} testID="case-row-impact">
          {item.impact}
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
  needsYou: { fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  impact: { fontSize: 14, color: "#333333" },
  meta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ago: { fontSize: 14, color: "#555555" },
});
