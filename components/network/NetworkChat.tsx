import { useRef, useState, type ComponentRef } from "react";
import { Keyboard, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChat } from "../../data";
import { useTheme } from "../../theme";
import { Icon, T, Turtle } from "../ui";
import type { NetworkSelection } from "./Constellation";

export function NetworkChat({ projectId, selection, name }: { projectId: string; selection: NetworkSelection; name: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const { messages, send, busy } = useChat(!selection ? { kind: "project", projectId } : selection.kind === "cluster" ? { kind: "cluster", projectId, clusterId: selection.id } : { kind: "node", projectId, nodeId: selection.id });
  const submit = async () => {
    if (!expanded) { setExpanded(true); return; }
    const value = text.trim();
    if (!value || busy) return;
    setError("");
    setText("");
    try { await send(value); } catch { setText(value); setError("That question didn’t send. Try again."); }
  };
  return (
    <View testID="network-panel" style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16), borderTopWidth: 1, borderTopColor: colors.border, gap: 12, backgroundColor: colors.bg }}>
      {expanded ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Turtle health="clear" size={28} />
            <T variant="small" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>Asking about {name}</T>
            <Pressable testID="network-chat-close" accessibilityRole="button" accessibilityLabel="Close codebase chat" onPress={() => { Keyboard.dismiss(); setExpanded(false); }} style={{ width: 44, height: 44, marginVertical: -8, alignItems: "center", justifyContent: "center" }}><Icon name="X" size={18} color="textMuted" /></Pressable>
          </View>
          {messages.length > 0 && <ScrollView ref={scroll} testID="network-messages" style={{ maxHeight: 144 }} contentContainerStyle={{ gap: 12, paddingVertical: 4 }} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
            {messages.map((message) => <View key={message.id} style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: message.role === "owner" ? colors.border : colors.brandDeep, gap: 2 }}><T variant="small" color="textMuted">{message.role === "owner" ? "You" : "turtl"}</T><T>{message.text}</T></View>)}
          </ScrollView>}
          {busy && <T variant="small" color="textMuted" accessibilityLiveRegion="polite">turtl is thinking…</T>}
          {!!error && <T variant="small" color="statusAffected" accessibilityRole="alert">{error}</T>}
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Turtle health="clear" size={36} />
          <View style={{ backgroundColor: colors.surface, borderRadius: 18, borderBottomLeftRadius: 5, paddingHorizontal: 14, paddingVertical: 10, flex: 1 }}><T variant="small">Questions about the codebase?</T></View>
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {expanded ? <TextInput ref={input} autoFocus value={text} onChangeText={setText} onSubmitEditing={submit} placeholder={selection ? "Ask about this part…" : "Ask about the whole codebase…"} placeholderTextColor={colors.textMuted} testID="network-question-input" accessibilityLabel={`Question about ${name}`} returnKeyType="send" style={{ flex: 1, minHeight: 48, borderRadius: 16, backgroundColor: colors.surface, paddingHorizontal: 14, fontSize: 16, color: colors.text, borderWidth: 1, borderColor: colors.border }} /> : <T variant="small" color="textMuted" style={{ flex: 1 }}>A little context. A clearer picture.</T>}
        <Pressable testID="network-question-send" accessibilityRole="button" accessibilityLabel={expanded ? "Send question" : "Ask about the codebase"} accessibilityState={{ disabled: expanded && (busy || !text.trim()) }} disabled={expanded && (busy || !text.trim())} onPress={submit} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 48, paddingHorizontal: 16, borderRadius: 24, backgroundColor: colors.brand, opacity: expanded && (busy || !text.trim()) ? 0.45 : pressed ? 0.8 : 1 })}><T variant="strong" color="onBrand">Ask</T><Turtle health="clear" size={25} /></Pressable>
      </View>
    </View>
  );
}
