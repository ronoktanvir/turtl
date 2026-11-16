import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AskBar } from "../../../components/execution/AskBar";
import { PlanGraph } from "../../../components/execution/PlanGraph";
import { formatDuration, remainingDuration } from "../../../components/execution/timing";
import { ApproveSheet, FixCard, kindLabel } from "../../../components/fix/FixCard";
import { Button, Card, Header, Icon, Reveal, Screen, T, Turtle } from "../../../components/ui";
import { useTalkSession } from "../../../components/voice/useTalkSession";
import { mergePullRequest, stopEnactment, useCase, useChat, useDataStatus, useEnactmentNow, useProject } from "../../../data";
import type { Enactment, FixOption, Health } from "../../../data/types";
import { healthToken, useTheme } from "../../../theme";

const states: Record<Enactment["state"], { word: string; health: Health }> = {
  running: { word: "turtl is working", health: "working" },
  needs_you: { word: "Stopped: turtl needs your decision", health: "needs_you" },
  waiting_for_merge: { word: "Ready for you to merge", health: "needs_you" },
  merged: { word: "Pull request merged", health: "working" },
  done: { word: "Done", health: "clear" },
  stopped: { word: "Stopped by you", health: "needs_you" },
  failed: { word: "This did not work", health: "affected" },
};

export default function Enacting() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const c = useCase(caseId);
  const { errors } = useDataStatus();
  const now = useEnactmentNow(caseId);
  const project = useProject(c?.projectId ?? "");
  const chat = useChat({ kind: "case", caseId });
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState(false);
  const talk = useTalkSession(caseId, () => setAsked(true));
  const [approving, setApproving] = useState<FixOption | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const controlPending = useRef(false);
  const [control, setControl] = useState<"stop" | "merge" | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const chatPending = useRef(false);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const e = c?.enactment;
  const back = ("/review/" + caseId) as never;
  // A case that is not this account's, or no longer exists, reads as not found, like the case screen.
  if (c === null) {
    return (
      <Screen testID="enacting">
        <Header title="Not found" fallback={"/projects" as never} />
        <T style={{ padding: 20 }} testID="enacting-not-found">This case could not be found.</T>
      </Screen>
    );
  }
  if (!c || !e) {
    return (
      <Screen testID="enacting">
        <Header title="Nothing is running" fallback={back} />
        {(c !== undefined || errors.length === 0) && <T style={{ padding: 20 }}>{c === undefined ? "Loading…" : "No fix has been approved for this case yet."}</T>}
      </Screen>
    );
  }

  const number = c.fixes.findIndex((f) => f.key === e.fixKey) + 1;
  const fix = c.fixes[number - 1];
  const pr = e.pullRequest;
  const state = states[e.state];
  const passed = pr?.checkRuns.filter((r) => r.status === "passed").length ?? 0;
  const ci = !pr
    ? !fix ? "Pull request details not available yet" : fix.delivery === "pull_request" ? "No pull request yet" : "This fix has nothing to merge"
    : pr.state === "merged" ? "Merged"
      : pr.state === "closed" ? "Pull request closed"
        : pr.checks === "passing" ? "Checks passed"
          : pr.checks === "failing" ? "Checks failed"
            : pr.checks === "none" ? "No checks reported"
              : "Checks running: " + passed + " of " + pr.checkRuns.length + " passed";
  const canStop = e.state === "running" || e.state === "needs_you" || e.state === "waiting_for_merge";
  const canMerge = fix?.delivery === "pull_request" && e.state === "waiting_for_merge" && pr?.state === "open" && pr.checks === "passing" && pr.mergeable;
  const completed = e.steps.filter((step) => step.status === "done").length;
  const remaining = remainingDuration(e.steps, now);
  const remainingLabel = e.state === "done" ? "Complete"
    : (e.state === "waiting_for_merge" ? "After your merge · "
      : e.state === "stopped" || e.state === "failed" ? "Stopped · "
        : e.state === "needs_you" ? "Paused · " : "")
      + (remaining === undefined ? "estimate pending" : `about ${formatDuration(Math.ceil(remaining / 1000) * 1000)} remaining`);
  const stop = async () => {
    if (!canStop || controlPending.current) return;
    controlPending.current = true;
    setControl("stop");
    setStopError(null);
    try {
      await stopEnactment(c.id);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "Could not stop this fix. Please try again.");
    } finally {
      controlPending.current = false;
      setControl(null);
    }
  };
  const merge = async () => {
    if (!pr || !canMerge || controlPending.current) return;
    controlPending.current = true;
    setControl("merge");
    setRefused(null);
    try {
      const result = await mergePullRequest(c.id, pr.headSha);
      setRefused(result.ok ? null : result.reason);
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "Could not merge. Please try again.");
    } finally {
      controlPending.current = false;
      setControl(null);
    }
  };
  const ask = async () => {
    const value = question.trim();
    if (!value || chat.busy || chatPending.current) return;
    chatPending.current = true;
    setSending(true);
    setChatError(null);
    try {
      await chat.send(value);
      setAsked(true);
      setQuestion((current) => current.trim() === value ? "" : current);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "That question could not be sent. Please try again.");
    } finally {
      chatPending.current = false;
      setSending(false);
    }
  };

  return (
    <Screen testID="enacting">
      <Header title={(project?.name ? project.name + (c.type === "feature" ? " request" : " error") : c.type === "feature" ? "Request" : "Error") + ": Fix " + number} fallback={back} testID="enacting-title" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 28, paddingBottom: insets.bottom + 40 }} testID="enacting-scroll">
          <Reveal>
            <View style={{ gap: 20 }}>
              <View style={{ gap: 8 }}>
                <T variant="display" testID="enacting-fix-title">{fix?.title ?? ""}</T>
                {fix && <T variant="small" color="textMuted">{kindLabel[fix.kind]}</T>}
              </View>
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <Turtle health={state.health} size={44} />
                <View style={{ flex: 1, gap: 3 }}>
                  <T variant="strong" color={healthToken[state.health]} testID="enacting-state">{state.word}</T>
                  <T variant="small" color="textMuted">{completed + " of " + e.steps.length + " steps complete"}</T>
                </View>
              </View>
              <T variant="small" color="textMuted" testID="enactment-remaining">{remainingLabel}</T>
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
                    <T variant="strong" font="title">{pr.title}</T>
                  </View>
                  <Icon name="ExternalLink" color="textMuted" size={16} />
                </Pressable>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Icon name="GitBranch" color="textMuted" size={16} />
                  <T variant="small" color="textMuted" style={{ flex: 1 }}>Latest commit</T>
                  <T variant="mono" color="textMuted" testID="enacting-pr-head">{pr.headSha}</T>
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
              <Button label={control === "stop" ? "Stopping…" : "Stop"} icon="X" kind="danger" disabled={!canStop || control !== null} onPress={() => void stop()} testID="enacting-stop" />
              <Button label={control === "merge" ? "Merging…" : "Merge"} icon="GitMerge" disabled={!canMerge || control !== null} onPress={() => void merge()} testID="enacting-merge" />
              <T variant="small" color={pr?.checks === "passing" ? "statusClear" : "textMuted"} style={{ flex: 1 }} testID="enacting-ci">{ci}</T>
            </View>
            {stopError && <T color="statusAffected" accessibilityRole="alert" testID="enacting-stop-error">{stopError}</T>}
            {refused && (
              <View style={{ flexDirection: "row", gap: 10, padding: 16, backgroundColor: colors.surface, borderRadius: 16 }}>
                <Icon name="TriangleAlert" color="statusNeedsYou" />
                <T color="statusNeedsYou" accessibilityRole="alert" style={{ flex: 1 }} testID="enacting-merge-refused">{refused}</T>
              </View>
            )}
          </View>

          {e.state === "done" && (
            <Card style={{ gap: 12, borderColor: colors.brandDeep }} testID="enacting-complete">
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Icon name="ShieldCheck" color="statusClear" size={24} />
                <T variant="heading">Fix complete</T>
              </View>
              <Button label="Back to Projects" icon="ArrowLeft" onPress={() => router.replace("/projects")} testID="enacting-home" />
            </Card>
          )}
          {e.state === "stopped" && (
            <View style={{ gap: 12 }} testID="enacting-stopped">
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Icon name="TriangleAlert" color="statusNeedsYou" size={20} />
                <T style={{ flex: 1 }}>Nothing more will run.</T>
              </View>
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
            <AskBar value={question} onChangeText={setQuestion} onSend={() => void ask()} busy={chat.busy || sending} placeholder="Any questions?" inputID="enacting-ask-input" sendID="enacting-ask-send" talk={talk} talkID="enacting-talk" />
            {chatError && <T color="statusAffected" accessibilityRole="alert" testID="enacting-chat-error">{chatError}</T>}
            {asked && chat.messages.slice(-2).map((m) => (
              <View key={m.id} style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: m.role === "owner" ? colors.border : colors.brandDeep, gap: 4 }}>
                <T variant="small" color="textMuted">{m.role === "owner" ? "You" : "turtl"}</T>
                <T testID={"enacting-" + m.role + "-message"}>{m.text}</T>
              </View>
            ))}
            {(chat.busy || sending) && <T color="textMuted" testID="enacting-chat-busy">turtl is thinking…</T>}
          </View>
          <Reveal delay={80}>
            <View style={{ gap: 16 }}>
              <T variant="title" accessibilityRole="header">Plan</T>
              <PlanGraph steps={e.steps} pullRequest={pr} now={now} />
            </View>
          </Reveal>
        </ScrollView>
      </KeyboardAvoidingView>
      <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} stay />
    </Screen>
  );
}
