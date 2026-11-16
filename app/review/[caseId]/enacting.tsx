import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApproveSheet, FixCard, kindLabel } from "../../../components/fix/FixCard";
import { Button, Card, Chip, Header, Screen, T, Turtle } from "../../../components/ui";
import { mergePullRequest, stopEnactment, useCase, useChat, useProject } from "../../../data";
import type { Enactment, FixOption, Health, PlanStep } from "../../../data/types";
import { healthToken, useTheme, type TokenName } from "../../../theme";

const states: Record<Enactment["state"], { word: string; health: Health }> = {
  running: { word: "turtl is working", health: "working" },
  needs_you: { word: "Stopped: turtl needs your decision", health: "needs_you" },
  waiting_for_merge: { word: "Ready for you to merge", health: "needs_you" },
  merged: { word: "Merged. turtl is checking the live app", health: "working" },
  done: { word: "Done", health: "clear" },
  stopped: { word: "Stopped by you", health: "needs_you" },
  failed: { word: "This did not work", health: "affected" },
};

const steps: Record<PlanStep["status"], { symbol: string; word: string; tone: TokenName }> = {
  pending: { symbol: "○", word: "Waiting", tone: "textMuted" },
  running: { symbol: "◐", word: "Working now", tone: "statusWorking" },
  done: { symbol: "✓", word: "Done", tone: "statusClear" },
  failed: { symbol: "!", word: "Stopped", tone: "statusNeedsYou" },
  skipped: { symbol: "–", word: "Skipped", tone: "textMuted" },
};

const runs = { pending: "○ Running", passed: "✓ Passed", failed: "✕ Failed" } as const;

export default function Enacting() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const c = useCase(caseId);
  const project = useProject(c?.projectId ?? "");
  const chat = useChat({ kind: "case", caseId });
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [approving, setApproving] = useState<FixOption | null>(null);

  const e = c?.enactment;
  const back = ("/review/" + caseId) as never;
  if (!c || !e) {
    return (
      <Screen testID="enacting">
        <Header title="Nothing is running" fallback={back} />
        <T style={{ padding: 16 }}>{c === undefined ? "Loading…" : "No fix has been approved for this case yet."}</T>
      </Screen>
    );
  }

  const number = c.fixes.findIndex((f) => f.key === e.fixKey) + 1;
  const fix = c.fixes[number - 1];
  const pr = e.pullRequest;
  const state = states[e.state];
  const passed = pr?.checkRuns.filter((r) => r.status === "passed").length ?? 0;
  const ci = !pr
    ? e.steps.some((s) => s.key === "open_pr")
      ? "No pull request yet"
      : "This fix has nothing to merge"
    : pr.state === "merged"
      ? "✓ Merged"
      : pr.state === "closed"
        ? "Pull request closed"
        : pr.checks === "passing"
          ? "✓ Checks passed"
          : pr.checks === "failing"
            ? "✕ Checks failed"
            : "Checks running: " + passed + " of " + pr.checkRuns.length + " passed";
  const canStop = e.state === "running" || e.state === "needs_you" || e.state === "waiting_for_merge";
  const canMerge = e.state === "waiting_for_merge" && !!pr?.mergeable;
  const asked = chat.messages.some((m) => m.role === "owner");
  const ask = () => {
    if (!question.trim()) return;
    chat.send(question);
    setQuestion("");
  };

  return (
    <Screen testID="enacting">
      <Header
        title={(project?.name ?? "") + (c.type === "feature" ? " request" : " error") + ": Fix " + number}
        fallback={back}
        testID="enacting-title"
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 96 }}>
          <View style={{ gap: 8 }}>
            <T variant="title" testID="enacting-fix-title">
              {fix?.title ?? ""}
            </T>
            {fix && <Chip label={kindLabel[fix.kind]} />}
          </View>

          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <Turtle health={state.health} size={48} />
            <T variant="strong" color={healthToken[state.health]} style={{ flex: 1 }} testID="enacting-state">
              {state.word}
            </T>
          </View>

          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <Button
              label="Stop"
              kind="danger"
              disabled={!canStop}
              onPress={() => stopEnactment(c.id)}
              testID="enacting-stop"
            />
            <Button label="Merge" disabled={!canMerge} onPress={() => mergePullRequest(c.id)} testID="enacting-merge" />
            <T variant="small" color={pr?.checks === "passing" ? "statusClear" : "textMuted"} style={{ flex: 1, fontWeight: "600" }} testID="enacting-ci">
              {ci}
            </T>
          </View>

          {pr && (
            <Card style={{ gap: 8 }} testID="enacting-pr">
              <Pressable onPress={() => Linking.openURL(pr.url)} accessibilityRole="link" testID="enacting-pr-link">
                <T variant="strong" color="link">
                  {"Pull request #" + pr.number + ": " + pr.title}
                </T>
              </Pressable>
              {pr.checkRuns.map((run) => (
                <View key={run.name} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <T style={{ flex: 1 }}>{run.name}</T>
                  <T
                    variant="small"
                    color={run.status === "passed" ? "statusClear" : run.status === "failed" ? "statusAffected" : "textMuted"}
                    style={{ fontWeight: "700" }}
                    testID={"enacting-check-" + run.name.toLowerCase().replace(/[^a-z]+/g, "-")}
                  >
                    {runs[run.status]}
                  </T>
                </View>
              ))}
            </Card>
          )}

          {c.learned && (
            <Card style={{ gap: 10, borderColor: colors.statusClear }} testID="enacting-learned">
              <T variant="strong">What turtl learned</T>
              <T>{c.learned}</T>
              <Button
                label="Back to Projects"
                onPress={() => (router.canDismiss() ? router.dismissAll() : router.replace("/"))}
                testID="enacting-home"
              />
            </Card>
          )}

          {e.state === "stopped" && (
            <Card style={{ gap: 10 }} testID="enacting-stopped">
              <T>Nothing more will run. You can choose another fix whenever you are ready.</T>
              <Button
                label="Back to the fixes"
                kind="plain"
                onPress={() => (router.canGoBack() ? router.back() : router.replace(back))}
                testID="enacting-back-to-fixes"
              />
            </Card>
          )}

          {e.question && (
            <View style={{ gap: 12 }} testID="enacting-question">
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Turtle health="needs_you" size={32} />
                <T variant="strong" style={{ flex: 1 }}>
                  {e.question.text}
                </T>
              </View>
              {e.question.fixes.map((option, i) => (
                <FixCard
                  key={option.key}
                  fix={option}
                  number={i + 1}
                  sources={{ citations: c.citations, logs: c.logs, code: c.code }}
                  defaultOpen={option.recommended}
                  onApprove={setApproving}
                  prefix="answer"
                />
              ))}
            </View>
          )}

          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Turtle health="clear" size={32} />
              <TextInput
                value={question}
                onChangeText={setQuestion}
                onSubmitEditing={ask}
                placeholder="Any question? Ask turtl"
                placeholderTextColor={colors.textMuted}
                returnKeyType="send"
                testID="enacting-ask-input"
                style={{
                  flex: 1,
                  minHeight: 48,
                  fontSize: 16,
                  color: colors.text,
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                }}
              />
              <Button label="Ask" kind="plain" disabled={chat.busy || !question.trim()} onPress={ask} testID="enacting-ask-send" />
            </View>
            {asked &&
              chat.messages.slice(-2).map((m) => (
                <T key={m.id} color={m.role === "owner" ? "textMuted" : "text"} testID={"enacting-" + m.role + "-message"}>
                  {(m.role === "owner" ? "You: " : "turtl: ") + m.text}
                </T>
              ))}
            {chat.busy && <T color="textMuted">turtl is thinking…</T>}
          </View>

          <View style={{ gap: 10 }}>
            <T variant="title" accessibilityRole="header">
              Plan
            </T>
            {e.steps.map((step, i) => {
              const look = steps[step.status];
              const open = openStep === step.key;
              return (
                <Card
                  key={step.key}
                  onPress={() => setOpenStep(open ? null : step.key)}
                  testID={"plan-step-" + step.key}
                  style={{ gap: 6, borderColor: step.status === "running" ? colors.statusWorking : colors.border }}
                >
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <T variant="strong" color="textMuted" style={{ width: 22 }}>
                      {i + 1 + "."}
                    </T>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T variant="strong">{step.title}</T>
                      <T variant="small" color={look.tone} style={{ fontWeight: "700" }} testID={"plan-step-status-" + step.key}>
                        {look.symbol + " " + look.word}
                      </T>
                      {step.summary && <T>{step.summary}</T>}
                      {open && step.detail && <T color="textMuted">{step.detail}</T>}
                    </View>
                    <T color="textMuted">{open ? "▾" : "▸"}</T>
                  </View>
                </Card>
              );
            })}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} stay />
    </Screen>
  );
}
