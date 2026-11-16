import { Ellipsis, Mic, Square, Volume2, X } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { useTheme } from "../../theme";
import { T } from "../ui";
import type { TalkSession } from "./useTalkSession";

const words: Record<Exclude<TalkSession["phase"], "idle">, string> = {
  starting: "Starting the microphone…",
  listening: "Listening. Ask about this case",
  thinking: "turtl is thinking…",
  speaking: "turtl is speaking",
};

// The talk control that sits beside the question line while no conversation is running.
export function TalkButton({ talk, disabled, testID }: { talk: TalkSession; disabled: boolean; testID?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={talk.start}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Talk with turtl"
      accessibilityHint="turtl listens, answers out loud, and listens again until you end the conversation. Speaking never approves anything."
      accessibilityState={{ disabled }}
      testID={testID}
      style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 14, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}
    >
      <Mic size={22} color={talk.available ? colors.brandDeep : colors.textMuted} strokeWidth={1.9} />
    </Pressable>
  );
}

// The question line while a conversation runs: what turtl is doing, the input level, and the controls.
export function TalkRow({ talk, testID }: { talk: TalkSession; testID?: string }) {
  const { colors } = useTheme();
  const phase = talk.phase === "idle" ? "starting" : talk.phase;
  const word = phase === "listening" && talk.heard ? "Listening… pause when you're done" : words[phase];
  const next = phase === "listening"
    ? { label: "Send", hint: "Send what you said now" }
    : phase === "speaking" ? { label: "Skip", hint: "Stop speaking and listen" } : null;
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingLeft: 6 }} testID={testID ? testID + "-session" : undefined}>
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", borderWidth: 2 + Math.round(talk.level * 6), borderColor: phase === "listening" ? colors.brandDeep : colors.border }}
      >
        {phase === "listening" ? <Mic size={18} color={colors.brandDeep} strokeWidth={2} /> : phase === "speaking" ? <Volume2 size={18} color={colors.brandDeep} strokeWidth={2} /> : <Ellipsis size={18} color={colors.textMuted} strokeWidth={2} />}
      </View>
      <T variant="small" color={phase === "listening" ? "text" : "textMuted"} accessibilityLiveRegion="polite" style={{ flex: 1 }} testID={testID ? testID + "-state" : undefined}>{word}</T>
      {next && (
        <Pressable
          onPress={talk.next}
          accessibilityRole="button"
          accessibilityLabel={next.label}
          accessibilityHint={next.hint}
          testID={testID ? testID + "-next" : undefined}
          style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceRaised, opacity: pressed ? 0.75 : 1 })}
        >
          <T variant="strong">{next.label}</T>
        </Pressable>
      )}
      <Pressable
        onPress={talk.end}
        accessibilityRole="button"
        accessibilityLabel="End voice conversation"
        testID={testID ? testID + "-end" : undefined}
        style={({ pressed }) => ({ minWidth: 44, minHeight: 44, flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center", paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.75 : 1 })}
      >
        {phase === "listening" ? <Square size={14} color={colors.text} fill={colors.text} /> : <X size={16} color={colors.text} />}
        <T variant="small">End</T>
      </Pressable>
    </View>
  );
}
