import { useLocalSearchParams } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AskBar } from "../../../components/execution/AskBar";
import { ApproveSheet, FixCard } from "../../../components/fix/FixCard";
import { useTalkSession } from "../../../components/voice/useTalkSession";
import { Button, devToolsOn, Header, Reveal, Screen, T, Turtle, useReducedMotion } from "../../../components/ui";
import { useCase, useChat } from "../../../data";
import type { FixOption } from "../../../data/types";
import { useTheme } from "../../../theme";

export default function InvestigateFurther() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const c = useCase(caseId);
  const chat = useChat({ kind: "case", caseId });
  const talk = useTalkSession(caseId);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const [text, setText] = useState("");
  const [approving, setApproving] = useState<FixOption | null>(null);
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState<"send" | "new_fix" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = chat.busy || submitting !== null;
  const send = async () => {
    const value = text.trim();
    if (!value || chat.busy || pending.current) return;
    pending.current = true;
    setSubmitting("send");
    setError(null);
    try {
      await chat.send(value);
      setText((current) => current.trim() === value ? "" : current);
    } catch (error) {
      setError(error instanceof Error ? error.message : "That question could not be sent. Please try again.");
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  };
  const newFix = async () => {
    if (!chat.requestNewFix || chat.busy || pending.current) return;
    pending.current = true;
    setSubmitting("new_fix");
    setError(null);
    try {
      await chat.requestNewFix();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not request a new fix. Please try again.");
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  };
  const active = !!c?.enactment && c.enactment.state !== "stopped";

  return (
    <Screen testID="chat">
      <Header title="Investigate further" fallback={("/review/" + caseId) as never} testID="chat-title" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={list}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: !reducedMotion })}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, gap: 28, paddingBottom: 28 }}
          testID="chat-messages"
        >
          <Reveal>
            <View style={{ gap: 16, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              {c && <T variant="title">{c.title}</T>}
              <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
                {c && <T variant="small" color="textMuted" style={{ flex: 1 }}>{c.number > 0 ? (c.type === "feature" ? "Request #" : "Error #") + c.number : c.type === "feature" ? "Request" : "Case"}</T>}
                <Button label={submitting === "new_fix" ? "Requesting…" : "New fix"} icon="Plus" kind="outline" disabled={busy || !chat.requestNewFix} onPress={() => void newFix()} testID="chat-new-fix" style={{ minHeight: 44, paddingHorizontal: 14 }} />
              </View>
            </View>
          </Reveal>
          {chat.messages.map((m) => (
            <View key={m.id} testID={"chat-message-" + m.id} style={{ gap: 12 }}>
              {m.role === "owner" ? (
                <View style={{ alignSelf: "flex-end", maxWidth: "90%", backgroundColor: colors.surfaceRaised, borderRadius: 20, borderBottomRightRadius: 6, padding: 16, gap: 4 }}>
                  <T variant="small" color="textMuted">You</T>
                  <T>{m.text}</T>
                </View>
              ) : (
                <View style={{ gap: 10 }}>
                  <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                    <Turtle health="clear" size={30} />
                    <T variant="strong" font="title">turtl</T>
                  </View>
                  <T>{m.text}</T>
                </View>
              )}
              {m.proposedFix && c && <FixCard fix={m.proposedFix} number={c.fixes.findIndex((f) => f.key === m.proposedFix?.key) + 1 || undefined} sources={{ citations: c.citations, logs: c.logs, code: c.code }} defaultOpen approveDisabled={active} onApprove={setApproving} prefix="proposal" />}
            </View>
          ))}
          {busy && <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Turtle health="working" size={30} />
            <T color="textMuted" testID="chat-busy">turtl is thinking…</T>
          </View>}
        </ScrollView>
        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + (devToolsOn ? 76 : 16), borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg }}>
          {error && <T color="statusAffected" accessibilityRole="alert" testID="chat-error" style={{ marginBottom: 8 }}>{error}</T>}
          <AskBar value={text} onChangeText={setText} onSend={() => void send()} busy={busy} placeholder="Ask about this case…" inputID="chat-input" sendID="chat-send" talk={talk} talkID="chat-talk" />
        </View>
      </KeyboardAvoidingView>
      {c && <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} />}
    </Screen>
  );
}
