import { useRouter, type Href } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProjectIcon from "../components/project/ProjectIcon";
import { Card, HealthWord, Icon, Reveal, Screen, T, Turtle, devToolsOn } from "../components/ui";
import { useProjects } from "../data";
import { healthOrder, healthToken, useTheme } from "../theme";

export default function Projects() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const projects = useProjects();
  const attention = projects?.filter((p) => p.health === "affected" || p.health === "needs_you").length ?? 0;
  const sorted = projects && [...projects].sort((a, b) => Number(b.needsApprovalCount > 0) - Number(a.needsApprovalCount > 0) || healthOrder.indexOf(a.health) - healthOrder.indexOf(b.health));
  return (
    <Screen testID="home">
      <ScrollView testID="projects-scroll" contentContainerStyle={{ padding: 20, gap: 28, paddingBottom: insets.bottom + 40 }}>
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <T variant="display" accessibilityRole="header">Projects</T>
            <Turtle health="clear" size={52} />
          </View>
          <T color="textMuted">{projects === undefined ? "Gathering your projects…" : projects.length === 0 ? "A quiet place for your next project." : `${projects.length} ${projects.length === 1 ? "project" : "projects"}. ${attention > 0 ? `${attention} ${attention === 1 ? "needs" : "need"} your attention.` : "Nothing needs your attention."}`}</T>
        </View>
        <View style={{ gap: 12 }}>
          {sorted?.map((p, index) => {
            const urgent = p.health === "affected" || p.health === "needs_you";
            return (
              <Reveal key={p.id} delay={index * 60}>
                <Card testID={`project-card-${p.id}`} onPress={() => router.push(`/project/${p.id}` as Href)} style={{ overflow: "hidden" }}>
                  {urgent && <View style={{ position: "absolute", left: 0, top: 22, bottom: 22, width: 3, borderRadius: 2, backgroundColor: colors[healthToken[p.health]] }} />}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <ProjectIcon project={p} size={44} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <T variant="heading">{p.name}</T>
                      <HealthWord health={p.health} />
                    </View>
                    <Turtle health={p.health} size={38} outlined={urgent} />
                  </View>
                  {p.summary && <T color="textMuted" numberOfLines={2} style={{ marginTop: 16 }}>{p.summary}</T>}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20 }}>
                    <View style={{ gap: 2 }}>
                      <T color="textMuted"><T variant="strong">{p.bugCount}</T> {p.bugCount === 1 ? "bug" : "bugs"}</T>
                      <T color="textMuted"><T variant="strong">{p.featureCount}</T> {p.featureCount === 1 ? "feature" : "features"}</T>
                    </View>
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexShrink: 1 }}>
                      <T variant="small" color={p.needsApprovalCount > 0 ? "statusNeedsYou" : "textMuted"} style={{ flexShrink: 1, textAlign: "right" }}>{p.needsApprovalCount > 0 ? `${p.needsApprovalCount} needs approval` : p.bugCount > 0 ? "Review fixes" : p.featureCount > 0 ? "Explore features" : "Explore project"}</T>
                      <Icon name="ArrowRight" size={18} color="textMuted" />
                    </View>
                  </View>
                </Card>
              </Reveal>
            );
          })}
          {projects?.length === 0 && <View style={{ alignItems: "center", paddingVertical: 40, gap: 12 }}><Icon name="Layers" size={36} color="brandDeep" /><T variant="heading">No projects yet</T><T color="textMuted" style={{ textAlign: "center" }}>Connected projects will appear here, with their fixes and features together.</T></View>}
        </View>
        {devToolsOn && <Pressable onPress={() => router.push("/live" as Href)} accessibilityRole="link" testID="home-live-cases" style={{ minHeight: 44, alignSelf: "center", justifyContent: "center" }}><T color="textMuted">Live cases</T></Pressable>}
      </ScrollView>
    </Screen>
  );
}
