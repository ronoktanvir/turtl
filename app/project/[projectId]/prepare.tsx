import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NeverBreakEditor } from "../../../components/onboarding/NeverBreakEditor";
import { PullRequestPanel } from "../../../components/onboarding/PullRequestPanel";
import { ReadinessReport } from "../../../components/onboarding/ReadinessReport";
import { WorksNow } from "../../../components/onboarding/WorksNow";
import { editableStages, inspectableStages, rulesNote, stageLine } from "../../../components/onboarding/stage";
import { CodingAgentNotice, useCodingAgentMissing } from "../../../components/secrets/CodingAgentNotice";
import ControlTokenSettings from "../../../components/secrets/ControlTokenSettings";
import { Button, Header, Icon, Reveal, Screen, Sheet, T, Turtle } from "../../../components/ui";
import { Empty } from "../../../components/ui/Empty";
import { approvePreparation, checkLiveAgain, inspectAgain, mergePreparation, refreshPreparation, saveNeverBreak, useDataStatus, useOnboarding, useProject } from "../../../data";
import type { NeverBreakAnswer } from "../../../data/onboarding/types";
import { healthToken, useTheme } from "../../../theme";

type Busy = "save" | "approve" | "merge" | "refresh" | "inspect" | "check";

export default function Prepare() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const onboarding = useOnboarding(projectId);
  const { errors } = useDataStatus();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [draft, setDraft] = useState<NeverBreakAnswer[] | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [merging, setMerging] = useState<{ title: string; headSha: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const agentMissing = useCodingAgentMissing();
  const title = (project?.name ?? "") + ": Preparation";
  const back = ("/project/" + projectId) as never;

  // A project that is not this account's, or no longer exists, reads as not found, like the project home.
  if (project === null) {
    return (
      <Screen testID="prepare">
        <Header title="Project not found" fallback="/projects" />
        <View style={{ padding: 20, gap: 16 }}>
          <T testID="prepare-not-found">This project is no longer available.</T>
          <Button label="Back to Projects" onPress={() => router.replace("/projects")} testID="prepare-not-found-back" />
        </View>
      </Screen>
    );
  }

  if (!onboarding) {
    return (
      <Screen testID="prepare">
        <Header title={title} fallback={back} />
        {onboarding === undefined
          ? errors.length === 0 && <T color="textMuted" style={{ padding: 20 }}>Loading…</T>
          : project?.practice
            ? <Empty testID="prepare-practice" message="The practice app has nothing to prepare." hint="Preparation reads a project's repository, and the practice app has none. turtl runs it and already watches it." action={{ label: "Back to project", onPress: () => (router.canGoBack() ? router.back() : router.replace(back)), testID: "prepare-practice-back" }} />
          : <Empty testID="prepare-empty" message="turtl has not read this project yet." hint="When it has, what it found and what it will watch for you show here." action={{ label: "Back to project", onPress: () => (router.canGoBack() ? router.back() : router.replace(back)), testID: "prepare-empty-back" }} />}
      </Screen>
    );
  }

  const run = async (kind: Busy, work: () => Promise<unknown>) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(kind);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work. Try again.");
      return false;
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  const o = onboarding;
  const inspection = o.inspection;
  const stage = stageLine(o);
  const editable = editableStages.includes(o.stage);
  const answers: NeverBreakAnswer[] = draft ?? o.neverBreak;
  const unsaved = draft !== null;
  const additions = [
    ...(inspection?.items ?? []).filter((i) => i.status !== "found").map((i) => i.label),
    ...o.neverBreak.filter((n) => n.addCheck).map((n) => "A check that " + n.text.charAt(0).toLowerCase() + n.text.slice(1)),
  ];
  const showAnswers = o.stage !== "unsupported" && (editable || o.neverBreak.length > 0);

  const save = async () => {
    if (await run("save", () => saveNeverBreak(o.projectId, answers))) setDraft(null);
  };
  const approve = async () => {
    if (!inspection) return;
    if (await run("approve", () => approvePreparation(o.projectId, inspection.id))) setApproving(false);
  };
  const merge = async () => {
    if (!merging) return;
    const shown = merging;
    setRefused(null);
    await run("merge", async () => {
      const result = await mergePreparation(o.projectId, shown.headSha);
      if (!result.ok) setRefused(result.reason);
    });
    setMerging(null);
  };

  const notes = [
    inspection?.readNote,
    inspection?.judgedBy === "rules" ? rulesNote(inspection.fallbackReason) : undefined,
    inspection?.error,
    o.problem,
  ].filter((note): note is string => !!note);

  return (
    <Screen testID="prepare">
      <Header title={title} fallback={back} testID="prepare-title" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 32, paddingBottom: insets.bottom + 40 }} testID="prepare-scroll">
          <Reveal>
            <View style={{ gap: 14 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                <Turtle health={stage.health} size={56} />
                <T variant="heading" color={healthToken[stage.health]} style={{ flex: 1 }} testID="prepare-stage">{stage.line}</T>
              </View>
              {inspection?.summary && <T>{inspection.summary}</T>}
              {notes.map((note) => (
                <View key={note} style={{ flexDirection: "row", gap: 10, padding: 14, borderRadius: 16, backgroundColor: colors.surface }}>
                  <Icon name="TriangleAlert" size={18} color="statusNeedsYou" />
                  <T style={{ flex: 1 }} testID="prepare-note">{note}</T>
                </View>
              ))}
              <T variant="small" color="textMuted">{o.repo + (o.folders.length ? " · " + o.folders.join(", ") : "") + (inspection?.ref ? " · read at " + inspection.ref.slice(0, 7) : "")}</T>
              {inspectableStages.includes(o.stage) && (
                <Pressable accessibilityRole="button" onPress={() => void run("inspect", () => inspectAgain(o.projectId))} disabled={busy !== null} testID="prepare-inspect-again" style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}>
                  <T color="link">{busy === "inspect" ? "Reading again…" : "Read the repository again"}</T>
                </Pressable>
              )}
            </View>
          </Reveal>

          {error && !approving && !merging && <T font="text" color="statusAffected" accessibilityRole="alert" testID="prepare-error">{error}</T>}

          <ReadinessReport onboarding={o} />

          {showAnswers && (
            <View style={{ gap: 14 }} testID="prepare-never-break">
              <View style={{ gap: 4 }}>
                <T variant="title" accessibilityRole="header">What must never break</T>
                {editable && <T color="textMuted">Switch on the ones turtl should check. It adds a check for each to the pull request.</T>}
              </View>
              <NeverBreakEditor answers={answers} editable={editable} onChange={setDraft} />
              {editable && (
                <Button label={busy === "save" ? "Saving…" : unsaved || !o.answered ? "Save answers" : "Answers saved"} kind="outline" disabled={busy !== null || (!unsaved && o.answered)} onPress={() => void save()} testID="prepare-save" />
              )}
            </View>
          )}

          {o.stage === "ready" && (
            <View style={{ gap: 10 }}>
              <CodingAgentNotice testID="prepare-coding-agent" />
              <Button label="Prepare my app" icon="Sparkles" disabled={unsaved || busy !== null || agentMissing} onPress={() => { setError(null); setApproving(true); }} testID="prepare-approve" />
              {unsaved && <T variant="small" color="textMuted" style={{ textAlign: "center" }}>Save your answers first.</T>}
            </View>
          )}

          {o.pullRequest && (
            <PullRequestPanel pr={o.pullRequest} showMerge={o.stage === "pr_open"} merging={busy === "merge"} refreshing={busy === "refresh"} onMerge={() => { setError(null); setMerging({ title: o.pullRequest!.title, headSha: o.pullRequest!.headSha }); }} onRefresh={() => void run("refresh", () => refreshPreparation(o.projectId))} />
          )}
          {refused && (
            <View style={{ flexDirection: "row", gap: 10, padding: 16, backgroundColor: colors.surface, borderRadius: 16 }}>
              <Icon name="TriangleAlert" color="statusNeedsYou" />
              <T font="text" color="statusNeedsYou" accessibilityRole="alert" style={{ flex: 1 }} testID="prepare-merge-refused">{refused}</T>
            </View>
          )}

          {(o.stage === "opening" || o.stage === "pr_open" || o.stage === "registering" || o.stage === "registered") && (
            <ControlTokenSettings projectId={o.projectId} testID="prepare-control-token" />
          )}

          {(o.stage === "registering" || o.stage === "registered") && (
            <WorksNow onboarding={o} checking={busy === "check"} onCheckAgain={() => void run("check", () => checkLiveAgain(o.projectId))} />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <Sheet visible={approving} onClose={() => { if (busy !== "approve") setApproving(false); }} title="Open a pull request that adds what is missing?" testID="prepare-approve-sheet">
        <View style={{ gap: 10 }}>
          {additions.map((line) => (
            <View key={line} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <View style={{ paddingTop: 3 }}><Icon name="Plus" size={16} color="brandDeep" /></View>
              <T style={{ flex: 1 }}>{line}</T>
            </View>
          ))}
        </View>
        <T color="textMuted">Nothing changes in your live app until you merge it.</T>
        {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="prepare-approve-error">{error}</T>}
        <View style={{ gap: 10 }}>
          <Button label={busy === "approve" ? "Opening…" : "Open the pull request"} disabled={busy !== null} onPress={() => void approve()} testID="prepare-approve-confirm" />
          <Button label="Cancel" kind="plain" disabled={busy === "approve"} onPress={() => setApproving(false)} testID="prepare-approve-cancel" />
        </View>
      </Sheet>

      <Sheet visible={merging !== null} onClose={() => { if (busy !== "merge") setMerging(null); }} title={"Merge: " + (merging?.title ?? "") + "?"} testID="prepare-merge-sheet">
        <T>{"turtl merges commit " + (merging?.headSha.slice(0, 7) ?? "") + ", the version shown here. Then it checks each new endpoint on your live app."}</T>
        <View style={{ gap: 10 }}>
          <Button label={busy === "merge" ? "Merging…" : "Merge"} icon="GitMerge" disabled={busy !== null} onPress={() => void merge()} testID="prepare-merge-confirm" />
          <Button label="Cancel" kind="plain" disabled={busy === "merge"} onPress={() => setMerging(null)} testID="prepare-merge-cancel" />
        </View>
      </Sheet>
    </Screen>
  );
}
