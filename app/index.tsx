import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../convex/_generated/api";
import { CaseRow } from "../components/feed/CaseRow";

export default function Home() {
  const cases = useQuery(api.cases.listWithSteps);
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.title}>turtl</Text>
      {cases === undefined ? (
        <Text style={styles.note} testID="home-loading">
          Loading…
        </Text>
      ) : cases.length === 0 ? (
        <View style={styles.empty} testID="home-empty">
          <Text style={styles.emptyTitle}>No cases</Text>
          <Text style={styles.note}>When something breaks, it will show up here.</Text>
        </View>
      ) : (
        <FlatList
          data={cases}
          keyExtractor={(row) => row._id}
          renderItem={({ item }) => <CaseRow item={item} now={now} />}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }]}
          testID="case-list"
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
