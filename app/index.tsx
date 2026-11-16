import { useRouter, type Href } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProjectIcon from "../components/project/ProjectIcon";
import { Card, HealthWord, Logo, Screen, T, Turtle } from "../components/ui";
import { useProjects } from "../data";
import { worstHealth } from "../theme";

const devTools = __DEV__ || process.env.EXPO_PUBLIC_DEV_TOOLS === "1";

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  if (!projects) {
    return (
      <Screen testID="home">
        <T style={{ padding: 20 }}>Loading…</T>
      </Screen>
    );
  }
  const health = worstHealth(projects.map((p) => p.health));
  return (
    <Screen testID="home">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 90 }}>
        <View style={{ gap: 4, alignItems: "flex-start" }}>
          <Logo health={health} width={220} />
          <HealthWord health={health} />
        </View>
        <T variant="display" accessibilityRole="header">
          Projects
        </T>
        {projects.map((p) => {
          const urgent = p.health === "affected" || p.health === "needs_you";
          return (
            <Card
              key={p.id}
              testID={`project-card-${p.id}`}
              onPress={() => router.push(`/project/${p.id}` as Href)}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <ProjectIcon project={p} />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <T variant="heading" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {p.name}
                    </T>
                    {urgent && (
                      <T variant="heading" color="statusAffected" style={{ fontWeight: "900" }}>
                        !
                      </T>
                    )}
                  </View>
                  <T>
                    {p.bugCount} {p.bugCount === 1 ? "bug" : "bugs"}
                  </T>
                  <T>
                    {p.featureCount} {p.featureCount === 1 ? "feature" : "features"}
                  </T>
                  {p.needsApprovalCount > 0 && <T color="statusNeedsYou">{`${p.needsApprovalCount} needs approval`}</T>}
                </View>
                <View style={{ alignItems: "center", gap: 4 }}>
                  <Turtle health={p.health} size={56} outlined={urgent} />
                  <HealthWord health={p.health} />
                </View>
              </View>
            </Card>
          );
        })}
        {devTools && (
          <Pressable
            onPress={() => router.push("/live" as Href)}
            accessibilityRole="link"
            testID="home-live-cases"
            style={{ paddingVertical: 12, alignSelf: "center" }}
          >
            <T color="textMuted">Live cases</T>
          </Pressable>
        )}
      </ScrollView>
    </Screen>
  );
}
