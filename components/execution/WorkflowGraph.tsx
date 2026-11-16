import { useState } from "react";
import { Platform, Pressable, View, type LayoutRectangle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { layoutWorkflow, nameSteps, plainWords, statusWords, type Workflow, type WorkflowStatus } from "../../data/workflow";
import { useTheme, type TokenName } from "../../theme";
import { Icon, T, type IconName } from "../ui";
import { formatDuration, formatStart } from "./timing";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const listed = (items: string[]) => (items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1]);

const statuses: Record<WorkflowStatus, { color: TokenName; icon: IconName }> = {
  pending: { color: "textMuted", icon: "GitBranch" },
  running: { color: "statusWorking", icon: "Sparkles" },
  waiting: { color: "statusNeedsYou", icon: "MessageCircle" },
  done: { color: "statusClear", icon: "Check" },
  failed: { color: "statusAffected", icon: "TriangleAlert" },
  skipped: { color: "textMuted", icon: "ArrowRight" },
};

export function WorkflowGraph({ workflow }: { workflow: Workflow }) {
  const { colors } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [rows, setRows] = useState<Record<string, LayoutRectangle>>({});
  const [cells, setCells] = useState<Record<string, LayoutRectangle>>({});
  const graph = layoutWorkflow(workflow.steps);
  const groups = [...graph.layers.map((steps) => ({ steps, unordered: false })), ...(graph.unresolved.length ? [{ steps: graph.unresolved, unordered: true }] : [])];
  const displayRows = groups.flatMap((group, layer) => {
    const result = [];
    for (let i = 0; i < group.steps.length; i += 2) result.push({ id: `${layer}-${i}`, steps: group.steps.slice(i, i + 2), unordered: group.unordered });
    return result;
  });
  const positions = new Map(displayRows.flatMap((row) => row.steps.flatMap((step) => {
    const r = rows[row.id];
    const cell = cells[step.id];
    return r && cell ? [[step.id, { ...cell, x: r.x + cell.x, y: r.y + cell.y }] as const] : [];
  })));
  const detail = workflow.steps.find((step) => step.id === selected);
  const attempt = detail?.currentAttempt;
  // Steps and attempts are named by their titles; an id turtl has no record of reads as plain words.
  const stepName = (key: string) => `“${workflow.steps.find((step) => step.key === key)?.title ?? plainWords(key)}”`;
  const attemptName = (id: string) => {
    const step = workflow.steps.find((s) => s.currentAttempt?.id === id);
    return step ? `“${step.title}”` : "an earlier try";
  };

  return <View style={{ gap: 16, minWidth: 0 }} testID="workflow-plan">
    <T variant="heading" accessibilityRole="header">Plan</T>
    <T color="textMuted">What turtl does for this case, in order. Steps side by side can run at the same time. Tap a step to see what it did.</T>
    {workflow.steps.length === 0 && <T color="textMuted">turtl has not recorded any steps for this case yet.</T>}
    {graph.issues.map((issue, i) => <T key={i} color="statusNeedsYou" testID="workflow-warning">{issue}</T>)}
    <View style={{ gap: 40, paddingHorizontal: 12, paddingVertical: 12 }} testID="workflow-graph" onLayout={({ nativeEvent: { layout } }) => setSize({ width: layout.width, height: layout.height })}>
      <Svg width={size.width} height={size.height} style={{ position: "absolute", left: 0, top: 0 }} pointerEvents="none" {...(Platform.OS === "web" ? { "aria-hidden": true } : { accessible: false })}>
        {graph.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + from.width / 2;
          const y1 = from.y + from.height;
          const x2 = to.x + to.width / 2;
          const y2 = to.y;
          const adjacent = y2 > y1 && y2 - y1 <= 42;
          const mid = (y1 + y2) / 2;
          const d = adjacent ? `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2 - 5}`
            : `M ${x1} ${y1} L ${x1} ${y1 + 12} L 4 ${y1 + 12} L 4 ${y2 - 12} L ${x2} ${y2 - 12} L ${x2} ${y2 - 5}`;
          return <Path key={`${edge.from}-${edge.to}`} testID={`workflow-edge-${edge.from}-${edge.to}`} d={`${d} M ${x2 - 3} ${y2 - 8} L ${x2} ${y2 - 4} L ${x2 + 3} ${y2 - 8}`} fill="none" stroke={colors.textMuted} strokeWidth={1.5} />;
        })}
      </Svg>
      {displayRows.map((row) => <View key={row.id} onLayout={({ nativeEvent: { layout } }) => setRows((old) => ({ ...old, [row.id]: layout }))} style={{ flexDirection: "row", gap: 12, alignItems: "stretch" }}>
        {row.steps.map((step) => {
          const look = statuses[step.status];
          const open = selected === step.id;
          return <Pressable key={step.id}
            onLayout={({ nativeEvent: { layout } }) => setCells((old) => ({ ...old, [step.id]: layout }))}
            onPress={() => setSelected(open ? null : step.id)}
            accessibilityRole="button"
            accessibilityLabel={`${step.title}, ${statusWords[step.status]}${row.unordered ? ", order unknown" : ""}`}
            accessibilityHint="Shows what this step did and what it waits for"
            accessibilityState={{ expanded: open }}
            aria-expanded={open}
            testID={`workflow-step-${step.key}`}
            style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 88, padding: 12, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: open ? colors.link : colors[look.color], backgroundColor: pressed ? colors.surfaceRaised : colors.surface })}>
            <Icon name={look.icon} color={look.color} size={20} />
            <T variant="strong" style={{ flexShrink: 1 }}>{step.title}</T>
            <T variant="small" color={look.color}>{statusWords[step.status]}</T>
            {row.unordered && <T variant="small" color="textMuted">Order unknown</T>}
          </Pressable>;
        })}
      </View>)}
    </View>
    {detail && <View accessibilityLiveRegion="polite" style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.surface, minWidth: 0 }} testID="workflow-step-detail">
      <T variant="heading" accessibilityRole="header">{detail.title}</T>
      <T color={statuses[detail.status].color}>{statusWords[detail.status]}</T>
      <T>{detail.dependsOn.length ? `Runs after ${listed(detail.dependsOn.map(stepName))}.` : "Runs first."}</T>
      {attempt && <>
        <T color="textMuted">{[
          attempt.attempt > 1 ? `Tried ${attempt.attempt} times.` : "Tried once.",
          attempt.startedAt !== undefined ? `Started ${formatStart(attempt.startedAt)}` + (attempt.finishedAt !== undefined ? (attempt.finishedAt - attempt.startedAt < 1000 ? ", took under a second." : `, took ${formatDuration(attempt.finishedAt - attempt.startedAt)}.`) : ".") : "",
        ].filter(Boolean).join(" ")}</T>
        {attempt.summary && <T>{nameSteps(attempt.summary, workflow.steps)}</T>}
        {attempt.error && <T color="statusAffected">{nameSteps(attempt.error, workflow.steps)}</T>}
      </>}
      {!attempt && detail.status !== "skipped" && <T color="textMuted">This step has not run yet.</T>}
      {detail.skipReason && <T>{`Skipped: ${nameSteps(detail.skipReason, workflow.steps)}`}</T>}
      {!!attempt?.inputRefs.length && <T>{`Built on what ${listed([...new Set(attempt.inputRefs.map(attemptName))])} found.`}</T>}
      {!!attempt?.outputRefs.length && <View style={{ gap: 4 }}>
        <T variant="strong">What it recorded</T>
        {attempt.outputRefs.map((ref, i) => <T key={i}>{ref.label ?? capitalized(plainWords(ref.kind))}</T>)}
      </View>}
    </View>}
  </View>;
}
