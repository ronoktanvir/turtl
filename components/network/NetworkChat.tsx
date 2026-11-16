import { useRef, useState, type ComponentRef } from "react";
import { Keyboard, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChat } from "../../data";
import { useTheme } from "../../theme";
import { Icon, T, Turtle } from "../ui";
import type { NetworkSelection } from "./Constellation";

export function NetworkChat({ projectId, selection, name, expanded, onExpandedChange }: { projectId: string; selection: NetworkSelection; name: string; expanded: boolean; onExpandedChange: (expanded: boolean) => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const setExpanded = onExpandedChange;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const chat = useChat(!selection ? { kind: "project", projectId } : selection.kind === "cluster" ? { kind: "cluster", projectId, clusterId: selection.id } : { kind: "node", projectId, nodeId: selection.id });
  const { messages, send } = chat;
  const busy = chat.busy || submitting;
  const submit = async () => {
    const value = text.trim();
    if (!value || chat.busy || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setExpanded(true);
    setError("");
    try {
      await send(value);
      setText((current) => current.trim() === value ? "" : current);
    } catch (error) {
      setError(error instanceof Error ? error.message : "That question didn’t send. Try again.");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };
  return (
    <View testID="network-panel" style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16), borderTopWidth: 1, borderTopColor: colors.border, gap: 12, backgroundColor: colors.bg }}>
      {expanded && (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <T variant="small" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>Asking about {name}</T>
            <Pressable testID="network-chat-close" accessibilityRole="button" accessibilityLabel="Close chat" onPress={() => { input.current?.blur(); Keyboard.dismiss(); setExpanded(false); }} style={{ width: 44, height: 44, marginVertical: -8, alignItems: "center", justifyContent: "center" }}><Icon name="X" size={18} color="textMuted" /></Pressable>
          </View>
          {messages.length > 0 && <ScrollView ref={scroll} testID="network-messages" style={{ maxHeight: 144 }} contentContainerStyle={{ gap: 12, paddingVertical: 4 }} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
            {messages.map((message) => <View key={message.id} style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: message.role === "owner" ? colors.border : colors.brandDeep, gap: 2 }}><T variant="small" color="textMuted">{message.role === "owner" ? "You" : "turtl"}</T><T>{message.text}</T></View>)}
          </ScrollView>}
          {busy && <T variant="small" color="textMuted" accessibilityLiveRegion="polite">turtl is thinking…</T>}
          {!!error && <T variant="small" color="statusAffected" accessibilityRole="alert">{error}</T>}
        </>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Turtle health="clear" size={28} />
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          onFocus={() => setExpanded(true)}
          onSubmitEditing={submit}
          placeholder="Ask about your code"
          placeholderTextColor={colors.textMuted}
          testID="network-question-input"
          accessibilityLabel={`Question about ${name}`}
          returnKeyType="send"
          submitBehavior="submit"
          multiline
          style={{ flex: 1, minWidth: 0, minHeight: 64, maxHeight: 96, borderRadius: 18, borderBottomLeftRadius: 6, backgroundColor: colors.surface, paddingHorizontal: 12, paddingVertical: 10, fontFamily: "Capriola_400Regular", fontSize: 16, lineHeight: 22, color: colors.text, borderWidth: 1, borderColor: colors.border, textAlignVertical: "center" }}
        />
        <Pressable testID="network-question-send" accessibilityRole="button" accessibilityLabel="Send question" accessibilityState={{ disabled: busy || !text.trim() }} disabled={busy || !text.trim()} onPress={submit} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 48, paddingHorizontal: 12, borderRadius: 24, backgroundColor: colors.brand, opacity: busy || !text.trim() ? 0.45 : pressed ? 0.8 : 1 })}><T variant="strong" color="onBrand">Ask</T><Turtle health="clear" size={20} /></Pressable>
      </View>
    </View>
  );
}
