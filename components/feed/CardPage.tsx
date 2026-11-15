import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  CARD_STATUS_COLORS,
  CARD_STATUS_LABELS,
  STEP_STATUS_COLORS,
  STEP_STATUS_LABELS,
  stageLabel,
  type buildCards,
} from "./cards";
import { StatusBadge } from "./StatusBadge";

export function CardPage({
  card,
  width,
}: {
  card: ReturnType<typeof buildCards>[number];
  width: number;
}) {
  return (
    <View style={{ width, padding: 16 }}>
      <ScrollView style={styles.card} contentContainerStyle={styles.content} testID={`card-${card.id}`}>
        <Text style={styles.name} testID={`card-title-${card.id}`}>
          {card.name}
        </Text>
        <StatusBadge
          label={CARD_STATUS_LABELS[card.status]}
          color={CARD_STATUS_COLORS[card.status]}
          testID={`card-status-${card.id}`}
        />
        <Text style={styles.copy}>{card.copy}</Text>
        {card.steps.length === 0 ? (
          <Text style={styles.empty}>No steps yet.</Text>
        ) : (
          card.steps.map((step) => (
            <View key={step._id} style={styles.step} testID={`step-${step.stage}`}>
              <Text style={styles.stage}>{stageLabel(step.stage)}</Text>
              <View style={styles.stepMeta}>
                <StatusBadge
                  label={STEP_STATUS_LABELS[step.status]}
                  color={STEP_STATUS_COLORS[step.status]}
                  testID={`step-status-${step.stage}`}
                />
                <Text style={styles.attempt} testID={`step-attempt-${step.stage}`}>
                  Attempt {step.attempt}
                </Text>
              </View>
              <Text style={styles.summary} testID={`step-summary-${step.stage}`}>
                {step.summary}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#C7C7CC",
    backgroundColor: "#FFFFFF",
  },
  content: { padding: 20, gap: 12 },
  name: { fontSize: 24, fontWeight: "700", color: "#111111" },
  copy: { fontSize: 16, lineHeight: 22, color: "#333333" },
  empty: { fontSize: 14, color: "#555555" },
  step: { gap: 6, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#C7C7CC" },
  stage: { fontSize: 16, fontWeight: "600", color: "#111111" },
  stepMeta: { flexDirection: "row", gap: 12, alignItems: "center" },
  attempt: { fontSize: 14, color: "#555555" },
  summary: { fontSize: 15, color: "#333333" },
});
