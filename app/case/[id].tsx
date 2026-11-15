import { useQuery } from "convex/react";
import { Link, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../convex/_generated/api";
import { buildCards, CASE_STATUS_COLORS, CASE_STATUS_LABELS } from "../../components/feed/cards";
import { CardPage } from "../../components/feed/CardPage";
import { CaseKindChip } from "../../components/feed/CaseKindChip";
import { StatusBadge } from "../../components/feed/StatusBadge";

export default function CaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useQuery(api.cases.get, { id });
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const list = useRef<FlatList>(null);

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setPage(Math.round(e.nativeEvent.contentOffset.x / width));

  const goTo = (index: number) => {
    list.current?.scrollToIndex({ index, animated: true });
    setPage(index);
  };

  const cards = item ? buildCards(item.steps) : [];

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Link href="/" asChild>
        <Pressable style={styles.back} testID="back-to-cases" accessibilityRole="button">
          <Text style={styles.backText}>‹ Cases</Text>
        </Pressable>
      </Link>
      {item === undefined ? (
        <Text style={styles.note} testID="case-loading">
          Loading…
        </Text>
      ) : item === null ? (
        <Text style={styles.note} testID="case-not-found">
          This case was not found.
        </Text>
      ) : (
        <>
          <View style={styles.header}>
            <Text style={styles.title} testID="case-title">
              {item.title}
            </Text>
            <StatusBadge
              label={CASE_STATUS_LABELS[item.status]}
              color={CASE_STATUS_COLORS[item.status]}
              testID="case-status"
            />
            <CaseKindChip kind={item.kind} raisedBy={item.raisedBy} testIDPrefix="case" />
          </View>
          <FlatList
            ref={list}
            data={cards}
            keyExtractor={(card) => card.id}
            renderItem={({ item }) => <CardPage card={item} width={width} />}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onScrollEnd}
            getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
            testID="card-pager"
          />
          <View style={styles.dots} testID="page-indicator" accessibilityLabel={`Card ${page + 1} of ${cards.length}`}>
            {cards.map((card, index) => (
              <Pressable
                key={card.id}
                onPress={() => goTo(index)}
                hitSlop={8}
                testID={`page-dot-${card.id}`}
                style={[styles.dot, index === page && styles.dotActive]}
              />
            ))}
            <Text style={styles.pageText}>
              {page + 1} / {cards.length}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F2F2F7" },
  back: { paddingHorizontal: 16, paddingVertical: 10, alignSelf: "flex-start" },
  backText: { fontSize: 17, color: "#0A84FF" },
  header: { paddingHorizontal: 16, gap: 6 },
  title: { fontSize: 24, fontWeight: "700", color: "#111111" },
  note: { fontSize: 16, color: "#555555", textAlign: "center", padding: 24 },
  dots: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, paddingVertical: 12 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#C7C7CC" },
  dotActive: { backgroundColor: "#111111" },
  pageText: { fontSize: 14, color: "#555555", marginLeft: 8 },
});
