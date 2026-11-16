import { useLocalSearchParams, type Href } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Header, HealthWord, Screen, T, Turtle } from "../../../components/ui";
import { useChat, useCodeNetwork, useProject } from "../../../data";
import type { NetNode } from "../../../data/types";
import { useTheme } from "../../../theme";

const CANVAS_W = 900;
const CANVAS_H = 1150;
const REGION_W = 380;
const REGION_H = 340;
const RING = 105;
const kindLetter: Record<NetNode["kind"], string> = { screen: "S", module: "M", service: "V", data: "D", external: "X" };
const kindWord: Record<NetNode["kind"], string> = {
  screen: "Screen",
  module: "Module",
  service: "Service",
  data: "Data",
  external: "External service",
};

type Selection = { kind: "cluster"; id: string } | { kind: "node"; id: string } | null;

function Panel({ projectId, selection, name, children }: {
  projectId: string;
  selection: Selection;
  name: string;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const scope = !selection
    ? ({ kind: "project", projectId } as const)
    : selection.kind === "cluster"
      ? ({ kind: "cluster", projectId, clusterId: selection.id } as const)
      : ({ kind: "node", projectId, nodeId: selection.id } as const);
  const { messages, send, busy } = useChat(scope);
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    send(value);
  };
  return (
    <View
      testID="network-panel"
      style={{ backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, maxHeight: "45%" }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 12 }}
      >
        {children}
        {messages.map((m) => (
          <View
            key={m.id}
            style={{
              flexDirection: "row",
              gap: 8,
              alignItems: "flex-start",
              justifyContent: m.role === "owner" ? "flex-end" : "flex-start",
            }}
          >
            {m.role === "turtl" && <Turtle health="clear" size={28} />}
            <View
              style={{
                maxWidth: "80%",
                borderRadius: 12,
                padding: 10,
                backgroundColor: m.role === "owner" ? colors.surfaceRaised : "transparent",
                borderWidth: m.role === "owner" ? 0 : 1,
                borderColor: colors.border,
              }}
            >
              <T>{m.text}</T>
            </View>
          </View>
        ))}
        {busy && <T color="textMuted">turtl is thinking…</T>}
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingRight: 90 }}>
          <Pressable
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel="Send question"
            testID="network-question-send"
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              backgroundColor: colors.brand,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <T variant="heading" color="onBrand">
              ↑
            </T>
          </Pressable>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            placeholder={selection ? "Ask about " + name : "Ask about the whole codebase"}
            placeholderTextColor={colors.textMuted}
            testID="network-question-input"
            accessibilityLabel="Ask turtl a question"
            style={{
              flex: 1,
              minHeight: 48,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 12,
              paddingHorizontal: 12,
              fontSize: 16,
              color: colors.text,
              backgroundColor: colors.bg,
            }}
          />
        </View>
      </ScrollView>
    </View>
  );
}

export default function Investigate() {
  const { projectId: rawId } = useLocalSearchParams<{ projectId: string }>();
  const projectId = rawId ?? "";
  const project = useProject(projectId);
  const network = useCodeNetwork(projectId);
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const [scale, setScale] = useState(1);
  const [selection, setSelection] = useState<Selection>(null);
  const back = ("/project/" + projectId) as Href;

  if (project === undefined || network === undefined) {
    return (
      <Screen testID="investigate-screen">
        <Header title="Investigate" fallback={back} />
        <View style={{ padding: 20 }}>
          <T color="textMuted">Loading…</T>
        </View>
      </Screen>
    );
  }
  if (project === null || network === null) {
    return (
      <Screen testID="investigate-screen">
        <Header title={project ? project.name + ": Investigate" : "Investigate"} fallback={back} />
        <View style={{ padding: 24, alignItems: "center", gap: 16 }}>
          <Turtle health="clear" size={96} />
          <T style={{ textAlign: "center" }}>turtl has not mapped this project's code yet.</T>
        </View>
      </Screen>
    );
  }

  const centers = new Map<string, { x: number; y: number }>();
  network.clusters.forEach((c, i) => {
    centers.set(c.id, { x: 250 + (i % 2) * 400, y: 200 + Math.floor(i / 2) * 380 });
  });
  const pos = new Map<string, { x: number; y: number }>();
  network.clusters.forEach((c) => {
    const center = centers.get(c.id)!;
    const members = network.nodes.filter((n) => n.clusterId === c.id);
    members.forEach((n, i) => {
      if (members.length === 1) return pos.set(n.id, center);
      const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(n.id, { x: center.x + Math.cos(angle) * RING, y: center.y + 12 + Math.sin(angle) * RING * 0.9 });
    });
  });
  const clusterOf = (nodeId: string) => network.nodes.find((n) => n.id === nodeId)?.clusterId;
  const edgeActive = (from: string, to: string) => {
    if (!selection) return false;
    if (selection.kind === "node") return from === selection.id || to === selection.id;
    return clusterOf(from) === selection.id || clusterOf(to) === selection.id;
  };
  const nodeRelated = (n: NetNode) => {
    if (!selection) return true;
    if (selection.kind === "cluster") {
      return (
        n.clusterId === selection.id ||
        network.edges.some(
          (e) => (e.from === n.id && clusterOf(e.to) === selection.id) || (e.to === n.id && clusterOf(e.from) === selection.id),
        )
      );
    }
    return (
      n.id === selection.id ||
      network.edges.some((e) => (e.from === selection.id && e.to === n.id) || (e.to === selection.id && e.from === n.id))
    );
  };
  const clusterRelated = (id: string) => {
    if (!selection) return true;
    if (selection.kind === "cluster") return selection.id === id;
    return clusterOf(selection.id) === id;
  };

  const selectedCluster = selection?.kind === "cluster" ? network.clusters.find((c) => c.id === selection.id) : undefined;
  const selectedNode = selection?.kind === "node" ? network.nodes.find((n) => n.id === selection.id) : undefined;
  const name = selectedCluster?.name ?? selectedNode?.label ?? "";
  const toggle = (next: NonNullable<Selection>) =>
    setSelection((cur) => (cur && cur.kind === next.kind && cur.id === next.id ? null : next));

  return (
    <Screen testID="investigate-screen">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Header title={project.name + ": Investigate"} fallback={back} />
        <View style={{ flex: 1, minHeight: height * 0.25 }}>
          <ScrollView horizontal style={{ flex: 1 }} testID="network-scroll-x">
            <ScrollView testID="network-scroll-y">
              <View style={{ width: CANVAS_W * scale, height: CANVAS_H * scale, backgroundColor: colors.bg }}>
                {network.clusters.map((c) => {
                  const center = centers.get(c.id)!;
                  const selected = selection?.kind === "cluster" && selection.id === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => toggle({ kind: "cluster", id: c.id })}
                      accessibilityRole="button"
                      accessibilityLabel={"Cluster " + c.name}
                      testID={"network-cluster-" + c.id}
                      style={{
                        position: "absolute",
                        left: (center.x - REGION_W / 2) * scale,
                        top: (center.y - REGION_H / 2) * scale,
                        width: REGION_W * scale,
                        height: REGION_H * scale,
                        borderRadius: 32 * scale,
                        borderWidth: selected ? 4 : 1,
                        borderColor: selected ? colors.brand : colors.border,
                        opacity: clusterRelated(c.id) ? 1 : 0.35,
                      }}
                    >
                      <View
                        style={{
                          position: "absolute",
                          top: 0,
                          right: 0,
                          bottom: 0,
                          left: 0,
                          borderRadius: 32 * scale,
                          backgroundColor: colors.surfaceRaised,
                          opacity: 0.35,
                        }}
                      />
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 12 }}>
                        {c.health && c.health !== "clear" && <Turtle health={c.health} size={28} />}
                        <T variant="strong" style={{ flexShrink: 1 }} numberOfLines={1}>
                          {c.name}
                        </T>
                      </View>
                    </Pressable>
                  );
                })}
                {network.edges.map((e, i) => {
                  const a = pos.get(e.from);
                  const b = pos.get(e.to);
                  if (!a || !b) return null;
                  const active = edgeActive(e.from, e.to);
                  const dim = !!selection && !active;
                  const dx = (b.x - a.x) * scale;
                  const dy = (b.y - a.y) * scale;
                  const len = Math.sqrt(dx * dx + dy * dy);
                  const thick = active ? 4 : 2;
                  return (
                    <View
                      key={i}
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: ((a.x + b.x) / 2) * scale - len / 2,
                        top: ((a.y + b.y) / 2) * scale - thick / 2,
                        width: len,
                        height: thick,
                        backgroundColor: active ? colors.link : colors.textMuted,
                        opacity: dim ? 0.15 : active ? 1 : 0.6,
                        transform: [{ rotate: Math.atan2(dy, dx) + "rad" }],
                      }}
                    />
                  );
                })}
                {network.nodes.map((n) => {
                  const p = pos.get(n.id);
                  if (!p) return null;
                  const size = (30 + (n.weight ?? 1) * 14) * scale;
                  const selected = selection?.kind === "node" && selection.id === n.id;
                  return (
                    <Pressable
                      key={n.id}
                      onPress={() => toggle({ kind: "node", id: n.id })}
                      accessibilityRole="button"
                      accessibilityLabel={n.label + ", " + kindWord[n.kind]}
                      testID={"network-node-" + n.id}
                      style={{
                        position: "absolute",
                        left: p.x * scale - 70,
                        top: p.y * scale - size / 2,
                        width: 140,
                        alignItems: "center",
                        opacity: nodeRelated(n) ? 1 : 0.25,
                      }}
                    >
                      <View
                        style={{
                          width: size,
                          height: size,
                          borderRadius: size / 2,
                          backgroundColor: colors.surface,
                          borderWidth: selected ? 4 : 2,
                          borderColor: selected ? colors.brand : colors.brandDeep,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <T variant="strong">{kindLetter[n.kind]}</T>
                      </View>
                      <T variant="small" style={{ textAlign: "center" }} numberOfLines={2}>
                        {n.label}
                      </T>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </ScrollView>
          <View style={{ position: "absolute", top: 12, right: 12, gap: 8 }}>
            {[
              { id: "network-zoom-in", label: "+", name: "Zoom in", next: Math.min(1.4, scale + 0.2) },
              { id: "network-zoom-out", label: "−", name: "Zoom out", next: Math.max(0.6, scale - 0.2) },
            ].map((z) => (
              <Pressable
                key={z.id}
                onPress={() => setScale(z.next)}
                accessibilityRole="button"
                accessibilityLabel={z.name}
                testID={z.id}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <T variant="title">{z.label}</T>
              </Pressable>
            ))}
          </View>
        </View>
        <Panel projectId={projectId} selection={selection} name={name}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <T variant="title">{selectedCluster?.name ?? selectedNode?.label ?? "Whole codebase"}</T>
              {selectedCluster?.health && <HealthWord health={selectedCluster.health} />}
              {selectedNode && <T color="textMuted">{kindWord[selectedNode.kind]}</T>}
              {selectedNode?.path && <T variant="mono">{selectedNode.path}</T>}
              <T>
                {selectedCluster?.summary ??
                  selectedNode?.summary ??
                  "Drag the map to look around, tap a region or a dot to see what happens there, then ask turtl a question."}
              </T>
            </View>
            {selection && (
              <Pressable
                onPress={() => setSelection(null)}
                accessibilityRole="button"
                accessibilityLabel="Clear selection"
                testID="network-clear"
                hitSlop={8}
                style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
              >
                <T variant="title" color="textMuted">
                  ×
                </T>
              </Pressable>
            )}
          </View>
        </Panel>
      </KeyboardAvoidingView>
    </Screen>
  );
}
