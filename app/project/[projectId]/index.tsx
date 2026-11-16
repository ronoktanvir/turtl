import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProjectIcon from "../../../components/project/ProjectIcon";
import SettingsSheet from "../../../components/project/SettingsSheet";
import { Button, HealthWord, Header, Screen, T, Turtle } from "../../../components/ui";
import { useProject } from "../../../data";
import { useTheme } from "../../../theme";

export default function ProjectHome() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [settings, setSettings] = useState(false);

  if (project === undefined) {
    return (
      <Screen testID="project-home">
        <T style={{ padding: 20 }}>Loading…</T>
      </Screen>
    );
  }
  if (project === null) {
    return (
      <Screen testID="project-home">
        <Header title="Project not found" fallback="/" />
        <View style={{ padding: 20, gap: 16 }}>
          <T>Project not found</T>
          <Button label="Back to projects" onPress={() => router.replace("/")} testID="project-not-found-back" />
        </View>
      </Screen>
    );
  }

  const boxes = [
    { id: "project-fix", label: "Fix", count: project.bugCount, href: `/project/${project.id}/fix` },
    { id: "project-features", label: "Features", count: project.featureCount, href: `/project/${project.id}/features` },
    { id: "project-investigate", label: "Investigate", count: undefined, href: `/project/${project.id}/investigate` },
  ];
  const link = (label: string, testID: string, url: string) => (
    <Pressable
      key={testID}
      onPress={() => Linking.openURL(url)}
      accessibilityRole="link"
      testID={testID}
      hitSlop={6}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <T color="link" style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );

  return (
    <Screen testID="project-home">
      <Header
        title={project.name}
        fallback="/"
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <ProjectIcon project={project} size={32} />
            <Pressable
              onPress={() => setSettings(true)}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              testID="project-settings"
              hitSlop={8}
              style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
            >
              <T variant="title">⚙</T>
            </Pressable>
          </View>
        }
      />
      <View style={{ flex: 1, padding: 16, gap: 16, paddingBottom: insets.bottom + 90 }}>
        {(project.repoUrl || project.productionUrl) && (
          <View style={{ flexDirection: "row", gap: 20 }}>
            {project.repoUrl && link("GitHub", "project-github", project.repoUrl)}
            {project.productionUrl && link("Live app", "project-live-app", project.productionUrl)}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ alignItems: "center", gap: 4 }}>
            <Turtle health={project.health} size={64} outlined={project.health === "affected" || project.health === "needs_you"} />
            <HealthWord health={project.health} />
          </View>
          {project.summary && <T style={{ flex: 1 }}>{project.summary}</T>}
        </View>
        <View style={{ flex: 1, gap: 12 }}>
          {boxes.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => router.push(b.href as Href)}
              accessibilityRole="button"
              testID={b.id}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 90,
                borderRadius: 20,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              })}
            >
              <T variant="display">{b.label}</T>
              {b.count !== undefined && <T color="textMuted">{b.count}</T>}
            </Pressable>
          ))}
        </View>
      </View>
      <SettingsSheet visible={settings} onClose={() => setSettings(false)} projectId={project.id} approvals={project.approvals} />
    </Screen>
  );
}
