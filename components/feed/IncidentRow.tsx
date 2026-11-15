import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { IncidentStatus } from "../../convex/constants";
import { INCIDENT_STATUS_COLORS, INCIDENT_STATUS_LABELS, timeAgo, type FeedStep } from "./cards";
import { ProgressStrip } from "./ProgressStrip";
import { StatusBadge } from "./StatusBadge";

export function IncidentRow({
  incident,
  now,
}: {
  incident: {
    _id: string;
    _creationTime: number;
    title: string;
    status: IncidentStatus;
    steps: FeedStep[];
  };
  now: number;
}) {
  return (
    <Link href={{ pathname: "/incident/[id]", params: { id: incident._id } }} asChild>
      <Pressable style={styles.row} testID="incident-row" accessibilityRole="button">
        <View style={styles.top}>
          <Text style={styles.title} testID="incident-row-title">
            {incident.title}
          </Text>
        </View>
        <View style={styles.meta}>
          <StatusBadge
            label={INCIDENT_STATUS_LABELS[incident.status]}
            color={INCIDENT_STATUS_COLORS[incident.status]}
            testID="incident-row-status"
          />
          <Text style={styles.ago} testID="incident-row-started">
            Started {timeAgo(incident._creationTime, now)}
          </Text>
        </View>
        <ProgressStrip steps={incident.steps} />
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
  top: { flexDirection: "row" },
  title: { flex: 1, fontSize: 17, fontWeight: "600", color: "#111111" },
  meta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ago: { fontSize: 14, color: "#555555" },
});
