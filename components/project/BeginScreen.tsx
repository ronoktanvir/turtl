import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useMemo } from "react";
import { PanResponder, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCases, useProject } from "../../data";
import type { CaseType } from "../../data/types";
import { labels, useTheme } from "../../theme";
import { Button, Chip, Header, Icon, Screen, T, Turtle, ago } from "../ui";

export default function BeginScreen({ type }: { type: CaseType }) {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const cases = useCases(projectId, type);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const firstId = cases?.[0]?.id;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dy < -10 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderRelease: (_, g) => {
          if (g.dy < -40 && firstId) router.push(`/review/${firstId}` as Href);
        },
      }),
    [firstId, router],
  );

  if (project === undefined || cases === undefined) {
    return (
      <Screen testID={`begin-${type}`}>
        <T style={{ padding: 20 }}>Loading…</T>
      </Screen>
    );
  }
  if (project === null) {
    return (
      <Screen testID={`begin-${type}`}>
        <Header title="Project not found" fallback={"/projects" as Href} />
        <View style={{ padding: 20 }}>
          <Button label="Back to projects" onPress={() => router.replace("/projects" as Href)} testID="begin-not-found-back" />
        </View>
      </Screen>
    );
  }

  const title = `${project.name}: ${type === "fix" ? "Fix" : labels.features}`;
  return (
    <Screen testID={`begin-${type}`}>
      <Header
        title={title}
        fallback={`/project/${project.id}` as Href}
        right={
          <T variant="small" color="textMuted" testID="begin-count">
            {cases.length}
          </T>
        }
      />
      {cases.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
          <Turtle health="clear" size={96} />
          <T color="textMuted" style={{ textAlign: "center" }}>
            {type === "fix" ? "Nothing to fix." : "No feature requests."}
          </T>
        </View>
      ) : (
        <ScrollView testID="begin-scroll" contentContainerStyle={{ flexGrow: 1 }}>
          <View style={{ flexGrow: 0 }}>
            <ScrollView horizontal testID="begin-case-strip" showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 20, gap: 12 }}>
              {cases.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => router.push(`/review/${c.id}` as Href)}
                  accessibilityRole="button"
                  testID={`begin-case-${c.id}`}
                  style={({ pressed }) => ({
                    width: 208,
                    minHeight: 152,
                    borderRadius: 20,
                    borderWidth: 1,
                    borderColor: c.status === "needs_approval" ? colors.statusNeedsYou : colors.border,
                    backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
                    padding: 16,
                    gap: 10,
                  })}
                >
                  <T variant="strong" numberOfLines={3}>
                    {c.title}
                  </T>
                  <T variant="small" color="textMuted" style={{ marginTop: "auto" }}>
                    {ago(c.happenedAt)}
                  </T>
                  {type === "feature" && c.reportCount !== undefined && (
                    <T variant="small" color="textMuted">{`${c.reportCount} asked`}</T>
                  )}
                  {c.status === "needs_approval" && <Chip label="Needs approval" tone="statusNeedsYou" />}
                </Pressable>
              ))}
            </ScrollView>
          </View>
          <View
            {...pan.panHandlers}
            style={{ flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}
          >
            <Pressable
              onPress={() => router.push(`/review/${cases[0].id}` as Href)}
              accessibilityRole="button"
              accessibilityLabel="Swipe up to review"
              testID="begin-review"
              style={({ pressed }) => ({ alignItems: "center", gap: 12, opacity: pressed ? 0.7 : 1 })}
            >
              <View
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="ArrowUp" size={36} color="brandDeep" strokeWidth={1.4} />
              </View>
              <T variant="heading">Swipe up to review</T>
            </Pressable>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
