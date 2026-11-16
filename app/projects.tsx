import { useRouter, type Href } from "expo-router";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProfileButton from "../components/account/ProfileButton";
import ProjectIcon from "../components/project/ProjectIcon";
import { Card, HealthWord, Icon, Reveal, Screen, T, Turtle, devToolsOn } from "../components/ui";
import { useDataStatus, useProjects } from "../data";
import type { Health } from "../data/types";
import { approvalLabel, healthOrder, healthToken, useTheme } from "../theme";

export default function Projects() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const projects = useProjects();
  const { errors } = useDataStatus();
  const health = projects?.length ? projects.reduce<Health>((worst, project) => healthOrder.indexOf(project.health) < healthOrder.indexOf(worst) ? project.health : worst, "clear") : undefined;
  const sorted = projects && [...projects].sort((a, b) => Number(b.needsApprovalCount > 0) - Number(a.needsApprovalCount > 0) || healthOrder.indexOf(a.health) - healthOrder.indexOf(b.health));
  return (
    <Screen testID="home">
      <ScrollView testID="projects-scroll" contentContainerStyle={{ padding: 20, gap: 28, paddingBottom: insets.bottom + 40 }}>
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <T variant="display" accessibilityRole="header">Projects</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Turtle health={health ?? "clear"} size={48} label={health ? undefined : "turtl"} />
              <ProfileButton />
            </View>
          </View>
          {projects && projects.length > 0 && health && <HealthWord health={health} testID="home-health" />}
        </View>
        <View style={{ gap: 12 }}>
          {sorted?.map((p, index) => {
            const urgent = p.health === "affected" || p.health === "needs_you";
            return (
              <Reveal key={p.id} delay={index * 60}>
                <Card testID={`project-card-${p.id}`} onPress={() => router.push(`/project/${p.id}` as Href)} style={{ overflow: "hidden", borderColor: urgent ? colors[healthToken[p.health]] : colors.border }}>
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
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.statusAffected }} /><T color="textMuted"><T variant="strong">{p.bugCount}</T> {p.bugCount === 1 ? "bug" : "bugs"}</T></View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.statusWorking }} /><T color="textMuted"><T variant="strong">{p.featureCount}</T> {p.featureCount === 1 ? "feature" : "features"}</T></View>
                    </View>
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexShrink: 1 }}>
                      <T variant="small" testID={`project-approvals-${p.id}`} color={p.needsApprovalCount > 0 ? "statusNeedsYou" : "textMuted"} style={{ flexShrink: 1, textAlign: "right" }}>{p.needsApprovalCount > 0 ? approvalLabel(p.needsApprovalCount) : p.bugCount > 0 ? "Review fixes" : p.featureCount > 0 ? "Explore features" : "Explore project"}</T>
                      <Icon name="ArrowRight" size={18} color="textMuted" />
                    </View>
                  </View>
                </Card>
              </Reveal>
            );
          })}
          {projects === undefined && errors.length === 0 && <T color="textMuted">Loading…</T>}
          {projects?.length === 0 && <View style={{ alignItems: "center", paddingVertical: 40, gap: 12 }}><Icon name="Layers" size={36} color="brandDeep" /><T variant="heading">No projects yet</T></View>}
          <Pressable onPress={() => router.push("/add-project" as Href)} accessibilityRole="button" testID="home-add-project" style={({ pressed }) => ({ minHeight: 48, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}><Icon name="Plus" size={18} color="brandDeep" /><T>Add project</T></Pressable>
        </View>
        {devToolsOn && <Pressable onPress={() => router.push("/live" as Href)} accessibilityRole="link" testID="home-live-cases" style={{ minHeight: 44, alignSelf: "center", justifyContent: "center" }}><T color="textMuted">Live cases</T></Pressable>}
      </ScrollView>
    </Screen>
  );
}
