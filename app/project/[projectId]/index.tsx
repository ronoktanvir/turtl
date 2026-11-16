import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import ProjectIcon from "../../../components/project/ProjectIcon";
import SettingsSheet from "../../../components/project/SettingsSheet";
import { Button, HealthWord, Header, Icon, Reveal, Screen, T, Turtle } from "../../../components/ui";
import { useProject } from "../../../data";
import { labels, useTheme } from "../../../theme";

export default function ProjectHome() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [settings, setSettings] = useState(false);

  if (project === undefined) return <Screen testID="project-home"><T style={{ padding: 20 }}>Loading…</T></Screen>;
  if (project === null) return <Screen testID="project-home"><Header title="Project not found" fallback="/projects" /><View style={{ padding: 20, gap: 16 }}><T>This project is no longer available.</T><Button label="Back to projects" onPress={() => router.replace("/projects")} testID="project-not-found-back" /></View></Screen>;

  return (
    <Screen testID="project-home">
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable testID="header-back" accessibilityRole="button" accessibilityLabel="Back to projects" onPress={() => router.replace("/projects")} style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="ArrowLeft" color="textMuted" /></Pressable>
        <ProjectIcon project={project} size={32} />
        <T variant="heading" accessibilityRole="header" style={{ flex: 1 }} numberOfLines={2}>{project.name}</T>
        <Pressable testID="project-settings" accessibilityRole="button" accessibilityLabel="Settings" onPress={() => setSettings(true)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="Settings2" color="textMuted" /></Pressable>
      </View>
      <ScrollView testID="project-home-scroll" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32, gap: 28 }}>
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Turtle health={project.health} size={48} />
            <View style={{ flex: 1, gap: 4 }}><HealthWord health={project.health} />{project.summary && <T color="textMuted">{project.summary}</T>}</View>
          </View>
          {(project.repoUrl || project.productionUrl) && <View style={{ flexDirection: "row", gap: 20, paddingLeft: 60 }}>
            {([{ label: "GitHub", id: "project-github", url: project.repoUrl, icon: "GitBranch" }, { label: "Live app", id: "project-live-app", url: project.productionUrl, icon: "ExternalLink" }] as const).map((link) => link.url && <Pressable key={link.id} testID={link.id} accessibilityRole="link" onPress={() => Linking.openURL(link.url!)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name={link.icon} size={15} color="textMuted" /><T variant="small" color="textMuted">{link.label}</T></Pressable>)}
          </View>}
        </View>
        <View style={{ gap: 12 }}>
          <Reveal>
            <Pressable testID="project-fix" accessibilityRole="button" onPress={() => router.push(`/project/${project.id}/fix` as Href)} style={({ pressed }) => ({ borderRadius: 20, borderWidth: 1, borderColor: colors.brandDeep, backgroundColor: pressed ? colors.surfaceRaised : colors.surface, padding: 20, overflow: "hidden", minHeight: 222 })}>
              <View pointerEvents="none" style={{ position: "absolute", right: -22, top: 6, opacity: 0.3 }}><Svg width={210} height={190} viewBox="0 0 210 190"><Circle cx="130" cy="80" r="73" stroke={colors.brandDeep} strokeWidth="1" fill="none" /><Circle cx="130" cy="80" r="52" stroke={colors.brandDeep} strokeWidth="1" fill="none" /><Path d="M32 145h42l24-48 22 22 24-60h49" stroke={colors.brandDeep} strokeWidth="2" fill="none" /><Circle cx="144" cy="59" r="5" fill={colors.brandDeep} /></Svg></View>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 20 }}><Icon name="Wrench" size={18} color="brandDeep" /><T variant="small" color="textMuted">CARE FOR YOUR APP</T></View>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}><T variant="display">Fix</T><T variant="title" color="brandDeep">{project.bugCount}</T></View>
              <T color="textMuted" style={{ marginTop: 8, maxWidth: "80%" }}>{project.bugCount === 0 ? "No open bugs. A little room to breathe." : project.needsApprovalCount > 0 ? `${project.needsApprovalCount} needs approval. You choose the next step.` : "Follow the evidence. Find a way forward."}</T>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 24 }}><T variant="strong" color="brandDeep">{project.bugCount === 0 ? "View fixes" : "Review fixes"}</T><Icon name="ArrowRight" color="brandDeep" /></View>
            </Pressable>
          </Reveal>
          <Reveal delay={60}>
            <Pressable testID="project-features" accessibilityRole="button" onPress={() => router.push(`/project/${project.id}/features` as Href)} style={({ pressed }) => ({ borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceRaised : colors.surface, padding: 20, overflow: "hidden" })}>
              <View pointerEvents="none" style={{ position: "absolute", right: 22, top: 12, opacity: 0.14, transform: [{ rotate: "-16deg" }] }}><Icon name="Layers" size={105} color="brandDeep" strokeWidth={1} /></View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><Icon name="Sparkles" size={20} color="brandDeep" /><T variant="title">{labels.features}</T><T variant="heading" color="textMuted">{project.featureCount}</T></View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 12 }}><T color="textMuted" style={{ flex: 1 }}>{project.featureCount === 0 ? "No open requests. Space for what’s next." : "Small ideas. Thoughtful next steps."}</T><Icon name="ArrowRight" size={18} color="textMuted" /></View>
            </Pressable>
          </Reveal>
          <Reveal delay={120}>
            <Pressable testID="project-investigate" accessibilityRole="button" onPress={() => router.push(`/project/${project.id}/investigate` as Href)} style={({ pressed }) => ({ borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceRaised : colors.bg, padding: 20, overflow: "hidden" })}>
              <View pointerEvents="none" style={{ position: "absolute", right: -8, top: 0, opacity: 0.3 }}><Svg width={130} height={140} viewBox="0 0 130 140"><Path d="M24 14 78 40 41 84 111 113M78 40l39-24M41 84l-24 43M78 40l33 73" stroke={colors.brandDeep} fill="none" />{[[24, 14], [78, 40], [41, 84], [111, 113], [117, 16], [17, 127]].map(([cx, cy], i) => <Circle key={i} cx={cx} cy={cy} r={i === 1 ? 7 : 4} fill={colors.bg} stroke={colors.brandDeep} strokeWidth="1.5" />)}</Svg></View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><Icon name="Network" size={20} color="brandDeep" /><T variant="title">Investigate</T></View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 12 }}><T color="textMuted" style={{ flex: 1 }}>See how the code connects.</T><Icon name="ArrowRight" size={18} color="textMuted" /></View>
            </Pressable>
          </Reveal>
        </View>
      </ScrollView>
      <SettingsSheet visible={settings} onClose={() => setSettings(false)} projectId={project.id} approvals={project.approvals} />
    </Screen>
  );
}
