import { useRouter, type Href } from "expo-router";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProfileButton from "../components/account/ProfileButton";
import ProjectIcon from "../components/project/ProjectIcon";
import FirstRun from "../components/project/FirstRun";
import { Card, HealthWord, Icon, Reveal, Screen, T, Turtle } from "../components/ui";
import { useDevToolsOn } from "../components/ui/devTools";
import { useDataStatus, useProjects } from "../data";
import { approvalLabel, healthOrder, healthToken, useTheme } from "../theme";

export default function Projects() {
  const devToolsOn = useDevToolsOn();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const projects = useProjects();
  const { errors } = useDataStatus();
  // Below 360 wide the icon and turtle give up a little room, so a name such as "Superprediction" is not broken mid-word.
  const narrow = useWindowDimensions().width < 360;
  const sorted = projects && [...projects].sort((a, b) => Number(b.needsApprovalCount > 0) - Number(a.needsApprovalCount > 0) || healthOrder.indexOf(a.health) - healthOrder.indexOf(b.health));
  return (
    <Screen testID="home">
      <ScrollView testID="projects-scroll" contentContainerStyle={{ padding: 20, gap: 28, paddingBottom: insets.bottom + 40 }}>
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <T variant="display" accessibilityRole="header">Projects</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Turtle health="clear" size={48} label="turtl" />
              <ProfileButton />
            </View>
          </View>
        </View>
        <View style={{ gap: 12 }}>
          {sorted?.map((p, index) => {
            const urgent = p.health === "affected" || p.health === "needs_you";
            return (
              <Reveal key={p.id} delay={index * 60}>
                <Card testID={`project-card-${p.id}`} onPress={() => router.push(`/project/${p.id}` as Href)} style={{ overflow: "hidden", borderColor: urgent ? colors[healthToken[p.health]] : colors.border }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: narrow ? 8 : 12 }}>
                    <ProjectIcon project={p} size={narrow ? 36 : 44} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <T variant="heading" numberOfLines={2}>{p.name}</T>
                      <HealthWord health={p.health} />
                    </View>
                    <Turtle health={p.health} size={narrow ? 30 : 38} outlined={urgent} />
                  </View>
                  {p.summary && <T color="textMuted" numberOfLines={2} style={{ marginTop: 16 }}>{p.summary}</T>}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20 }}>
                    <View style={{ gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.bugCount > 0 ? colors.statusAffected : colors.border }} /><T color="textMuted"><T variant="strong">{p.bugCount}</T> {p.bugCount === 1 ? "bug" : "bugs"}</T></View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.featureCount > 0 ? colors.statusWorking : colors.border }} /><T color="textMuted"><T variant="strong">{p.featureCount}</T> {p.featureCount === 1 ? "feature" : "features"}</T></View>
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
          {projects?.length === 0 && <FirstRun onAdd={() => router.push("/add-project" as Href)} />}
          {projects?.length !== 0 && <Pressable onPress={() => router.push("/add-project" as Href)} accessibilityRole="button" testID="home-add-project" style={({ pressed }) => ({ minHeight: 48, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}><Icon name="Plus" size={18} color="brandDeep" /><T>Add project</T></Pressable>}
        </View>
        {devToolsOn && <Pressable onPress={() => router.push("/live" as Href)} accessibilityRole="link" testID="home-live-cases" style={{ minHeight: 44, alignSelf: "center", justifyContent: "center" }}><T color="textMuted">Live cases</T></Pressable>}
      </ScrollView>
    </Screen>
  );
}
