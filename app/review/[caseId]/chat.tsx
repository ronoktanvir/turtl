import { useLocalSearchParams } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApproveSheet, FixCard } from "../../../components/fix/FixCard";
import { Button, devToolsOn, Header, Screen, T, Turtle } from "../../../components/ui";
import { useCase, useChat } from "../../../data";
import type { FixOption } from "../../../data/types";
import { useTheme } from "../../../theme";

export default function InvestigateFurther() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const c = useCase(caseId);
  const chat = useChat({ kind: "case", caseId });
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const [text, setText] = useState("");
  const [approving, setApproving] = useState<FixOption | null>(null);

  const send = () => {
    if (!text.trim()) return;
    chat.send(text);
    setText("");
  };
  const active = !!c?.enactment && c.enactment.state !== "stopped";

  return (
    <Screen testID="chat">
      <Header
        title="Investigate further"
        fallback={("/review/" + caseId) as never}
        testID="chat-title"
        right={
          <Button
            label="New fix"
            kind="outline"
            disabled={chat.busy}
            onPress={() => chat.requestNewFix?.()}
            testID="chat-new-fix"
            style={{ minHeight: 40, paddingHorizontal: 12 }}
          />
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={list}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          contentContainerStyle={{ padding: 16, gap: 14 }}
          testID="chat-messages"
        >
          {c && (
            <T color="textMuted">
              {(c.type === "feature" ? "Request #" : "Error #") + c.number + ": " + c.title}
            </T>
          )}
          {chat.messages.map((m) =>
            m.role === "owner" ? (
              <View
                key={m.id}
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "85%",
                  backgroundColor: colors.surfaceRaised,
                  borderRadius: 16,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
                testID={"chat-message-" + m.id}
              >
                <T>{m.text}</T>
              </View>
            ) : (
              <View key={m.id} style={{ flexDirection: "row", gap: 10 }} testID={"chat-message-" + m.id}>
                <Turtle health="clear" size={32} />
                <View style={{ flex: 1, gap: 10 }}>
                  <T>{m.text}</T>
                  {m.proposedFix && c && (
                    <FixCard
                      fix={m.proposedFix}
                      number={c.fixes.findIndex((f) => f.key === m.proposedFix?.key) + 1 || undefined}
                      sources={{ citations: c.citations, logs: c.logs, code: c.code }}
                      defaultOpen
                      approveDisabled={active}
                      onApprove={setApproving}
                      prefix="proposal"
                    />
                  )}
                </View>
              </View>
            ),
          )}
          {chat.busy && (
            <T color="textMuted" testID="chat-busy">
              turtl is thinking…
            </T>
          )}
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            paddingLeft: 16,
            paddingRight: devToolsOn ? 88 : 16,
            paddingTop: 10,
            paddingBottom: insets.bottom + 12,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.bg,
          }}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={send}
            placeholder="Ask turtl about this case"
            placeholderTextColor={colors.textMuted}
            returnKeyType="send"
            testID="chat-input"
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
          <Button label="Send" disabled={chat.busy || !text.trim()} onPress={send} testID="chat-send" />
        </View>
      </KeyboardAvoidingView>
      {c && <ApproveSheet caseId={c.id} fix={approving} onClose={() => setApproving(null)} />}
    </Screen>
  );
}
