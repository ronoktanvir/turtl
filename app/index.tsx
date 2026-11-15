import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../convex/_generated/api";
import { IncidentRow } from "../components/feed/IncidentRow";

export default function Home() {
  const incidents = useQuery(api.incidents.listWithSteps);
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.title}>turtl</Text>
      {incidents === undefined ? (
        <Text style={styles.note} testID="home-loading">
          Loading…
        </Text>
      ) : incidents.length === 0 ? (
        <View style={styles.empty} testID="home-empty">
          <Text style={styles.emptyTitle}>No incidents</Text>
          <Text style={styles.note}>When something breaks, it will show up here.</Text>
        </View>
      ) : (
        <FlatList
          data={incidents}
          keyExtractor={(incident) => incident._id}
          renderItem={({ item }) => <IncidentRow incident={item} now={now} />}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }]}
          testID="incident-list"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F2F2F7" },
  title: { fontSize: 32, fontWeight: "700", paddingHorizontal: 16, paddingVertical: 12, color: "#111111" },
  list: { paddingHorizontal: 16, gap: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: "#111111" },
  note: { fontSize: 16, color: "#555555", textAlign: "center", paddingHorizontal: 16 },
});
