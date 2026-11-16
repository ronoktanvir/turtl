import { View } from "react-native";
import type { Onboarding } from "../../data/onboarding/types";
import { useTheme } from "../../theme";
import { Button, Chip, T, ago } from "../ui";
import { Glyph } from "./Glyph";
import { checkKindLabel, checkStateWord } from "./stage";

const kindGlyph = { health: "HeartPulse", readiness: "Gauge", journey: "Route", flag: "Flag", recovery_hook: "LifeBuoy" } as const;
const stateGlyph = { works: "CircleCheck", failing: "CircleX", no_response: "TriangleAlert" } as const;

export function WorksNow({ onboarding, checking, onCheckAgain }: { onboarding: Onboarding; checking: boolean; onCheckAgain: () => void }) {
  const { colors } = useTheme();
  const registering = onboarding.stage === "registering";
  return (
    <View style={{ gap: 14 }} testID="prepare-works-now">
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <T variant="title" accessibilityRole="header">Works now</T>
        {onboarding.checkedAt && !registering && <T variant="small" color="textMuted">{"Checked " + ago(onboarding.checkedAt)}</T>}
      </View>
      {registering && <T color="textMuted">turtl is calling each new endpoint on your live app and registering the ones that respond.</T>}
      {onboarding.checksError && <T font="text" color="statusNeedsYou" accessibilityRole="alert" testID="prepare-checks-error">{onboarding.checksError}</T>}
      {onboarding.checksNote && <T font="text" color="textMuted" testID="prepare-checks-note">{onboarding.checksNote}</T>}
      {onboarding.checks.length > 0 && (
        <View style={{ borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
          {onboarding.checks.map((check, index) => {
            const state = checkStateWord[check.state];
            return (
              <View key={check.kind + check.url} testID={"prepare-check-" + index} style={{ flexDirection: "row", gap: 12, padding: 16, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>
                <View style={{ paddingTop: 2 }}><Glyph name={kindGlyph[check.kind]} size={20} color="brandDeep" /></View>
                <View style={{ flex: 1, gap: 4 }}>
                  <T variant="small" color="textMuted">{checkKindLabel[check.kind]}</T>
                  <T variant="strong">{check.name}</T>
                  <T color="textMuted">{check.detail}</T>
                  {check.registered && <Chip label="Registered" tone="statusClear" />}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
                  <Glyph name={stateGlyph[check.state]} size={16} color={state.color} />
                  <T variant="small" color={state.color} testID={"prepare-check-" + index + "-state"}>{state.word}</T>
                </View>
              </View>
            );
          })}
        </View>
      )}
      {!registering && <Button label={checking ? "Checking…" : "Check again"} kind="outline" disabled={checking} onPress={onCheckAgain} testID="prepare-check-again" />}
    </View>
  );
}
