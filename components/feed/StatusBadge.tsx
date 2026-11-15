import { StyleSheet, Text, View } from "react-native";

export function StatusBadge({
  label,
  color,
  testID,
}: {
  label: string;
  color: string;
  testID?: string;
}) {
  return (
    <View style={styles.badge}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]} testID={testID}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  label: { fontSize: 14, fontWeight: "600" },
});
