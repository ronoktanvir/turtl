import { StyleSheet, View } from "react-native";
import { buildCards, CARD_STATUS_COLORS, type FeedStep } from "./cards";

export function ProgressStrip({ steps }: { steps: readonly FeedStep[] }) {
  return (
    <View style={styles.strip} testID="progress-strip">
      {buildCards(steps).map((card) => (
        <View
          key={card.id}
          testID={`progress-segment-${card.id}`}
          accessibilityLabel={`${card.name}: ${card.status}`}
          style={[styles.segment, { backgroundColor: CARD_STATUS_COLORS[card.status] }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", gap: 4 },
  segment: { flex: 1, height: 6, borderRadius: 3 },
});
