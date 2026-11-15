import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  CARD_STATUS_COLORS,
  CARD_STATUS_LABELS,
  STEP_STATUS_COLORS,
  STEP_STATUS_LABELS,
  type buildCards,
} from "./cards";
import type { CardContent, Tone } from "./incident";
import { StatusBadge } from "./StatusBadge";
import { plainText } from "./plainWords";

const TONE_COLORS: Record<Tone, string> = {
  default: "#333333",
  muted: "#555555",
  good: CARD_STATUS_COLORS.done,
  bad: CARD_STATUS_COLORS.failed,
  warn: "#B25E00",
};

export function CardPage({
  card,
  width,
  content,
  footer,
}: {
  card: ReturnType<typeof buildCards>[number];
  width: number;
  content?: CardContent;
  footer?: ReactNode;
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
        {content ? (
          content.map((section) => (
            <View key={section.heading} style={styles.section}>
              <Text style={styles.heading}>{section.heading}</Text>
              {section.rows.map((row, index) => (
                <Text
                  key={index}
                  style={[styles.copy, { color: TONE_COLORS[row.tone ?? "default"] }]}
                  testID={row.testID}
                >
                  {row.label ? <Text style={styles.label}>{row.label}: </Text> : null}
                  {row.text}
                </Text>
              ))}
            </View>
          ))
        ) : (
          <Text style={styles.copy}>{card.copy}</Text>
        )}
        {footer}
        {card.steps.length === 0 ? (
          <Text style={styles.empty}>No steps yet.</Text>
        ) : (
          card.steps.map((step) => (
            <View key={step._id} style={styles.step} testID={`step-${step.key}`}>
              <Text style={styles.stage}>{step.title}</Text>
              <View style={styles.stepMeta}>
                <StatusBadge
                  label={STEP_STATUS_LABELS[step.status]}
                  color={STEP_STATUS_COLORS[step.status]}
                  testID={`step-status-${step.key}`}
                />
                <Text style={styles.attempt} testID={`step-attempt-${step.key}`}>
                  {step.currentAttempt ? `Attempt ${step.currentAttempt.attempt}` : "Not started"}
                </Text>
              </View>
              <Text style={styles.summary} testID={`step-summary-${step.key}`}>
                {plainText(step.currentAttempt?.summary ?? "", Date.now())}
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
  section: { gap: 4 },
  heading: { fontSize: 13, fontWeight: "700", color: "#555555", textTransform: "uppercase" },
  label: { fontWeight: "600" },
  empty: { fontSize: 14, color: "#555555" },
  step: { gap: 6, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#C7C7CC" },
  stage: { fontSize: 16, fontWeight: "600", color: "#111111" },
  stepMeta: { flexDirection: "row", gap: 12, alignItems: "center" },
  attempt: { fontSize: 14, color: "#555555" },
  summary: { fontSize: 15, color: "#333333" },
});
