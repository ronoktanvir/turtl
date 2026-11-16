import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AskBar } from "../../../components/execution/AskBar";
import { PlanGraph } from "../../../components/execution/PlanGraph";
import { ApproveSheet, FixCard, kindLabel } from "../../../components/fix/FixCard";
import { Button, Card, Header, Icon, Reveal, Screen, T, Turtle } from "../../../components/ui";
import { mergePullRequest, stopEnactment, useCase, useChat, useProject } from "../../../data";
import type { Enactment, FixOption, Health } from "../../../data/types";
import { healthToken, useTheme } from "../../../theme";

const states: Record<Enactment["state"], { word: string; health: Health }> = {
  running: { word: "turtl is working", health: "working" },
  needs_you: { word: "Stopped: turtl needs your decision", health: "needs_you" },
  waiting_for_merge: { word: "Ready for you to merge", health: "needs_you" },
  merged: { word: "Merged. turtl is checking the live app", health: "working" },
  done: { word: "Done", health: "clear" },
  stopped: { word: "Stopped by you", health: "needs_you" },
  failed: { word: "This did not work", health: "affected" },
};

export default function Enacting() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const c = useCase(caseId);
  const project = useProject(c?.projectId ?? "");
  const chat = useChat({ kind: "case", caseId });
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState(false);
  const [approving, setApproving] = useState<FixOption | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const e = c?.enactment;
  const back = ("/review/" + caseId) as never;
  if (!c || !e) {
    return (
      <Screen testID="enacting">
        <Header title="Nothing is running" fallback={back} />
        <T style={{ padding: 20 }}>{c === undefined ? "Loading…" : "No fix has been approved for this case yet."}</T>
      </Screen>
    );
  }

  const number = c.fixes.findIndex((f) => f.key === e.fixKey) + 1;
  const fix = c.fixes[number - 1];
  const pr = e.pullRequest;
  const state = states[e.state];
  const passed = pr?.checkRuns.filter((r) => r.status === "passed").length ?? 0;
  const ci = !pr
    ? e.steps.some((s) => s.key === "open_pr") ? "No pull request yet" : "This fix has nothing to merge"
    : pr.state === "merged" ? "Merged"
      : pr.state === "closed" ? "Pull request closed"
        : pr.checks === "passing" ? "Checks passed"
          : pr.checks === "failing" ? "Checks failed"
            : pr.checks === "none" ? "No checks reported"
              : "Checks running: " + passed + " of " + pr.checkRuns.length + " passed";
  const canStop = e.state === "running" || e.state === "needs_you" || e.state === "waiting_for_merge";
  const canMerge = e.state === "waiting_for_merge" && pr?.state === "open" && pr.checks === "passing" && pr.mergeable;
  const completed = e.steps.filter((step) => step.status === "done").length;
  const ask = () => {
    if (!question.trim() || chat.busy) return;
    chat.send(question.trim());
    setAsked(true);
    setQuestion("");
  };

  return (
    <Screen testID="enacting">
      <Header title={(project?.name ?? "") + (c.type === "feature" ? " request" : " error") + ": Fix " + number} fallback={back} testID="enacting-title" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 28, paddingBottom: insets.bottom + 40 }} testID="enacting-scroll">
          <Reveal>
            <View style={{ gap: 20 }}>
              <View style={{ gap: 8 }}>
                {fix && <T variant="small" color="textMuted">{kindLabel[fix.kind]}</T>}
                <T variant="display" testID="enacting-fix-title">{fix?.title ?? ""}</T>
              </View>
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <Turtle health={state.health} size={44} />
                <View style={{ flex: 1, gap: 3 }}>
                  <T variant="strong" color={healthToken[state.health]} testID="enacting-state">{state.word}</T>
                  <T variant="small" color="textMuted">{completed + " of " + e.steps.length + " steps complete"}</T>
                </View>
              </View>
              <View style={{ height: 3, backgroundColor: colors.border, borderRadius: 2, overflow: "hidden" }}>
                <View style={{ height: 3, width: `${e.steps.length ? completed / e.steps.length * 100 : 0}%`, backgroundColor: colors[healthToken[state.health]] }} />
              </View>
            </View>
          </Reveal>

          <View style={{ gap: 16 }}>
            {pr && (
              <View style={{ gap: 12 }} testID="enacting-pr">
                <Pressable onPress={() => Linking.openURL(pr.url)} accessibilityRole="link" testID="enacting-pr-link" style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}>
                  <Icon name="GitPullRequest" color="brandDeep" size={22} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T variant="small" color="textMuted">{"Pull request #" + pr.number}</T>
                    <T variant="strong">{pr.title}</T>
                  </View>
                  <Icon name="ExternalLink" color="textMuted" size={16} />
                </Pressable>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Icon name="GitBranch" color="textMuted" size={16} />
                  <T variant="mono" color="textMuted" testID="enacting-pr-head">{"Latest commit " + pr.headSha}</T>
                </View>
                {pr.checkRuns.map((run) => (
                  <View key={run.name} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Icon name={run.status === "passed" ? "Check" : run.status === "failed" ? "X" : "Terminal"} size={16} color={run.status === "passed" ? "statusClear" : run.status === "failed" ? "statusAffected" : "textMuted"} />
                    <T variant="small" style={{ flex: 1 }}>{run.name}</T>
                    <T variant="small" color={run.status === "passed" ? "statusClear" : run.status === "failed" ? "statusAffected" : "textMuted"} testID={"enacting-check-" + run.name.toLowerCase().replace(/[^a-z]+/g, "-")}>{run.status === "passed" ? "Passed" : run.status === "failed" ? "Failed" : "Pending"}</T>
                  </View>
                ))}
              </View>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Button label="Stop" kind="danger" disabled={!canStop} onPress={() => stopEnactment(c.id)} testID="enacting-stop" />
              <Button label="Merge" disabled={!canMerge || merging} onPress={async () => {
                if (!pr || merging) return;
                setMerging(true);
                try {
                  const result = await mergePullRequest(c.id, pr.headSha);
                  setRefused(result.ok ? null : result.reason);
                } catch {
                  setRefused("Could not merge. Please try again.");
                } finally {
                  setMerging(false);
                }
              }} testID="enacting-merge" />
              <T variant="small" color={pr?.checks === "passing" ? "statusClear" : "textMuted"} style={{ flex: 1 }} testID="enacting-ci">{ci}</T>
            </View>
            {refused && (
              <View style={{ flexDirection: "row", gap: 10, padding: 16, backgroundColor: colors.surface, borderRadius: 16 }}>
                <Icon name="TriangleAlert" color="statusNeedsYou" />
                <T color="statusNeedsYou" style={{ flex: 1 }} testID="enacting-merge-refused">{refused}</T>
              </View>
            )}
          </View>

          {e.state === "done" && (
            <Card style={{ gap: 12, borderColor: colors.brandDeep }} testID="enacting-complete">
              <Icon name="ShieldCheck" color="statusClear" size={28} />
              <T variant="heading">Fix complete</T>
              <T color="textMuted">The plan is complete. You can return to your projects.</T>
              <Button label="Back to Projects" onPress={() => router.replace("/projects")} testID="enacting-home" />
            </Card>
          )}
          {e.state === "stopped" && (
            <View style={{ gap: 12 }} testID="enacting-stopped">
              <T>Nothing more will run. You can choose another fix whenever you are ready.</T>
              <Button label="Back to the fixes" kind="plain" onPress={() => (router.canGoBack() ? router.back() : router.replace(back))} testID="enacting-back-to-fixes" />
            </View>
          )}
          {e.question && (
            <View style={{ gap: 12 }} testID="enacting-question">
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Turtle health="needs_you" size={32} />
                <T variant="strong" style={{ flex: 1 }}>{e.question.text}</T>
              </View>
              {e.question.fixes.map((option, i) => <FixCard key={option.key} fix={option} number={i + 1} sources={{ citations: c.citations, logs: c.logs, code: c.code }} defaultOpen={option.recommended} onApprove={setApproving} prefix="answer" />)}
            </View>
          )}
          <View style={{ gap: 12 }}>
            <AskBar value={question} onChangeText={setQuestion} onSend={ask} busy={chat.busy} placeholder="Any questions?" inputID="enacting-ask-input" sendID="enacting-ask-send" />
            {asked && chat.messages.slice(-2).map((m) => (
              <View key={m.id} style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: m.role === "owner" ? colors.border : colors.brandDeep, gap: 4 }}>
                <T variant="small" color="textMuted">{m.role === "owner" ? "You" : "turtl"}</T>
                <T testID={"enacting-" + m.role + "-message"}>{m.text}</T>
              </View>
            ))}
            {chat.busy && <T color="textMuted" testID="enacting-chat-busy">turtl is thinking…</T>}
          </View>
          <Reveal delay={80}>
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <T variant="title" accessibilityRole="header">Plan</T>
                <T variant="small" color="textMuted">Tap a step for details</T>
              </View>
              <PlanGraph steps={e.steps} pullRequest={pr} />
            </View>
          </Reveal>
        </ScrollView>
      </KeyboardAvoidingView>
      <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} stay />
    </Screen>
  );
}
