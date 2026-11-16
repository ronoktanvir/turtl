import { useLocalSearchParams, type Href } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, View } from "react-native";
import AiNotice from "../../../components/consent/AiNotice";
import { Constellation, type NetworkSelection } from "../../../components/network/Constellation";
import { NetworkChat } from "../../../components/network/NetworkChat";
import { Header, HealthWord, Icon, Reveal, Screen, T, Turtle } from "../../../components/ui";
import { useCodeNetwork, useDataStatus, useProject } from "../../../data";
import { useTheme } from "../../../theme";

export default function Investigate() {
  const { projectId: rawId } = useLocalSearchParams<{ projectId: string }>();
  const projectId = rawId ?? "";
  const project = useProject(projectId);
  const network = useCodeNetwork(projectId);
  const { errors } = useDataStatus();
  const { colors } = useTheme();
  const [selection, setSelection] = useState<NetworkSelection>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const select = (next: NetworkSelection) => { setChatOpen(false); setSelection(next); };
  const back = ("/project/" + projectId) as Href;
  const cluster = selection?.kind === "cluster" ? network?.clusters.find((c) => c.id === selection.id) : undefined;
  const node = selection?.kind === "node" ? network?.nodes.find((n) => n.id === selection.id) : undefined;
  const name = cluster?.name ?? node?.label ?? "all your code";

  return (
    <Screen testID="investigate-screen">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Header title="Investigate" fallback={back} right={<Icon name="Network" color="brandDeep" />} />
        {project !== null && <AiNotice uses={["openai", "supermemory"]} cannot="map your code or answer questions about it" style={{ marginHorizontal: 20, marginTop: 8 }} />}
        {project === null ? (
          <View style={{ flex: 1, padding: 28, justifyContent: "center", alignItems: "center", gap: 20 }}>
            <T style={{ textAlign: "center" }} testID="investigate-not-found">This project is no longer available.</T>
          </View>
        ) : network === undefined || project === undefined ? (
          <View style={{ padding: 20 }}>{errors.length === 0 && <T color="textMuted">Loading the map of your code…</T>}</View>
        ) : !network || network.nodes.length === 0 ? (
          <View style={{ flex: 1, padding: 28, justifyContent: "center", alignItems: "center", gap: 20 }}>
            <Turtle health="clear" size={72} />
            <T style={{ textAlign: "center" }}>turtl has not mapped this project's code yet.</T>
          </View>
        ) : (
          <>
            {"source" in network && network.source === "seed" && <T variant="small" color="statusNeedsYou" testID="network-source" style={{ paddingHorizontal: 20, paddingTop: 12 }}>Seeded example code network</T>}
            {!chatOpen && <View style={{ paddingHorizontal: 20, paddingTop: 20, gap: 4 }}>
              <Reveal>
                <T variant="strong" numberOfLines={1}>{project.name}</T>
                <T variant="small" color="textMuted">{network.nodes.length} {network.nodes.length === 1 ? "part" : "parts"} · {network.clusters.length} {network.clusters.length === 1 ? "group" : "groups"}</T>
              </Reveal>
            </View>}
            <Constellation network={network} selection={selection} onSelect={select} />
            {selection && !chatOpen && (
              <View testID="network-selection" style={{ marginHorizontal: 20, marginBottom: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1, minWidth: 0 }}><T variant="strong">{name}</T></View>
                  <Pressable testID="network-clear" accessibilityRole="button" accessibilityLabel="Clear selection" onPress={() => setSelection(null)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", marginVertical: -8 }}>
                    <Icon name="X" size={18} color="textMuted" />
                  </Pressable>
                </View>
                {cluster?.health && <HealthWord health={cluster.health} />}
                <T variant="small" color="textMuted" numberOfLines={3}>{cluster?.summary ?? node?.summary}</T>
                {node?.path && <T variant="mono" color="textMuted" numberOfLines={1} style={{ fontSize: 12 }}>{node.path}</T>}
              </View>
            )}
            <NetworkChat key={selection ? selection.kind + selection.id : "project"} projectId={projectId} selection={selection} name={name} expanded={chatOpen} onExpandedChange={setChatOpen} />
          </>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
