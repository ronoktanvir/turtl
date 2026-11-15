import { useQuery } from "convex/react";
import { StyleSheet, Text, View } from "react-native";
import { api } from "../convex/_generated/api";

export default function Home() {
  const incidents = useQuery(api.incidents.list);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>turtl</Text>
      <Text style={styles.count}>
        {incidents === undefined ? "Loading…" : `Incidents: ${incidents.length}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  title: { fontSize: 32, fontWeight: "700" },
  count: { fontSize: 18 },
});
