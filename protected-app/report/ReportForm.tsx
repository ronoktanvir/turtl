import { useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

// turtl's report form: "Report a problem" and "Request a feature". It posts the customer's words to turtl's public
// intake endpoint, which groups them into cases for the app's owner. This file is self-contained: copy it into any
// Expo or React Native app (see README.md next to it). It needs only react and react-native.
//
// Two settings, as props or as environment variables:
// - intakeKey (EXPO_PUBLIC_TURTL_INTAKE_KEY): the app's public intake key, tik_…. It names the app to turtl; it is
//   not a secret.
// - endpoint (EXPO_PUBLIC_TURTL_INTAKE_URL): https://<turtl deployment>.convex.site/intake/report.
//
// What is sent: the words, which button was pressed, a random id for this device (so one person counts once), and a
// random id for the message (so a retry is not counted twice). No name, email, account or location.

type Kind = "bug" | "request";
type State = { phase: "editing" } | { phase: "sending" } | { phase: "sent" } | { phase: "failed"; message: string };

const MAX_TEXT = 2000;

/** Where the customer reads how turtl handles their words: the report form section of turtl's privacy policy. */
export const POLICY_URL = "https://ronoktanvir.github.io/turtl/privacy/#if-you-use-the-report-form";

const randomId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
let memoryReporterId: string | null = null;
function reporterId() {
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    const saved = localStorage.getItem("still-reporter-id");
    if (saved) return saved;
    const made = randomId();
    localStorage.setItem("still-reporter-id", made);
    return made;
  }
  return (memoryReporterId ??= randomId());
}

const COPY: Record<Kind, { title: string; prompt: string; placeholder: string; thanks: string }> = {
  bug: {
    title: "Report a problem",
    prompt: "What went wrong? Tell us what you were doing and what you saw.",
    placeholder: "I picked a time and pressed Confirm booking, then…",
    thanks: "Thank you. Your report reached the team.",
  },
  request: {
    title: "Request a feature",
    prompt: "What would make booking better for you?",
    placeholder: "I'd love to be able to…",
    thanks: "Thank you. Your idea reached the team.",
  },
};

export function ReportForm({
  intakeKey = process.env.EXPO_PUBLIC_TURTL_INTAKE_KEY,
  endpoint = process.env.EXPO_PUBLIC_TURTL_INTAKE_URL,
}: { intakeKey?: string; endpoint?: string | null } = {}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ phase: "editing" });

  function open(next: Kind) {
    setKind(next === kind ? null : next);
    setText("");
    setState({ phase: "editing" });
  }

  async function send() {
    if (!kind || !text.trim() || state.phase === "sending") return;
    if (!endpoint || !intakeKey) {
      setState({ phase: "failed", message: "Reports aren't set up for this app yet." });
      return;
    }
    setState({ phase: "sending" });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: intakeKey, text: text.trim(), kind, reporterId: reporterId(), reportId: randomId() }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setState({ phase: "failed", message: body?.error?.message ?? "We couldn't send that. Please try again." });
        return;
      }
      setState({ phase: "sent" });
      setText("");
    } catch {
      setState({ phase: "failed", message: "We couldn't send that. Please check your connection and try again." });
    }
  }

  const copy = kind ? COPY[kind] : null;
  const disabled = !text.trim() || state.phase === "sending";
  return <View style={s.wrap}>
    <View style={s.row}>
      {(["bug", "request"] as const).map((item) => <Pressable key={item} testID={`turtl-report-open-${item}`} accessibilityRole="button" accessibilityLabel={COPY[item].title} accessibilityState={{ expanded: kind === item }} onPress={() => open(item)} style={[s.chip, kind === item && s.chipOn]}>
        <Text style={[s.chipText, kind === item && s.chipTextOn]}>{COPY[item].title}</Text>
      </Pressable>)}
    </View>
    {copy && <View style={s.panel}>
      {state.phase === "sent" ? <View style={s.sent}>
        <Text style={s.title}>{copy.thanks}</Text>
        <Pressable testID="turtl-report-again" accessibilityRole="button" accessibilityLabel="Send another" onPress={() => setState({ phase: "editing" })}><Text style={s.link}>Send another</Text></Pressable>
      </View> : <>
        <Text style={s.title}>{copy.title}</Text>
        <Text style={s.body}>{copy.prompt}</Text>
        <TextInput testID="turtl-report-text" accessibilityLabel={copy.title} multiline value={text} onChangeText={(value) => setText(value.slice(0, MAX_TEXT))} placeholder={copy.placeholder} placeholderTextColor="#a5aa9b" style={[s.input, s.textarea]} />
        <Text style={s.note} testID="turtl-report-notice">
          Your message goes to the team behind this app through turtl, a service that helps them find and fix problems. turtl and the AI services it uses read it to sort reports. Please leave out passwords, card numbers and other private details.{" "}
          <Text testID="turtl-report-policy" accessibilityRole="link" accessibilityLabel="How turtl handles your message (opens turtl's privacy policy)" onPress={() => { Linking.openURL(POLICY_URL).catch(() => undefined); }} style={s.noteLink}>How turtl handles your message</Text>
        </Text>
        {state.phase === "failed" && <Text accessibilityRole="alert" style={s.error}>{state.message}</Text>}
        <Pressable testID="turtl-report-send" accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled }} disabled={disabled} onPress={send} style={[s.send, disabled && s.sendOff]}>
          {state.phase === "sending" ? <ActivityIndicator color="#fff" /> : <Text style={s.sendText}>Send</Text>}
        </Pressable>
      </>}
    </View>}
  </View>;
}

// Colours match the booking demo. Change them to your app's own; nothing else depends on them.
const s = StyleSheet.create({
  wrap: { marginTop: 26, gap: 12 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chip: { borderWidth: 1, borderColor: "#d4dcc6", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: "#fffefa" },
  chipOn: { backgroundColor: "#2f5145", borderColor: "#2f5145" },
  chipText: { color: "#586d4d", fontSize: 12, fontWeight: "500" },
  chipTextOn: { color: "#fffefa" },
  panel: { backgroundColor: "#fffefa", borderRadius: 16, padding: 20, borderWidth: 1, borderColor: "#e6e6dc", gap: 10 },
  title: { fontSize: 18, letterSpacing: -0.5, color: "#2b3f34", fontWeight: "500" },
  body: { fontSize: 13, lineHeight: 20, color: "#7c8278" },
  input: { borderWidth: 1, borderColor: "#e2e5d9", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: "#3a493a", backgroundColor: "#ffffff" },
  textarea: { minHeight: 96, textAlignVertical: "top" },
  note: { fontSize: 11, lineHeight: 17, color: "#7c8278" },
  noteLink: { color: "#2f5145", textDecorationLine: "underline" },
  error: { color: "#9f6048", fontSize: 12 },
  send: { backgroundColor: "#2f5145", minHeight: 44, borderRadius: 9, alignItems: "center", justifyContent: "center", marginTop: 4 },
  sendOff: { opacity: 0.4 },
  sendText: { color: "#fffefa", fontSize: 12, fontWeight: "500" },
  sent: { gap: 10, paddingVertical: 6 },
  link: { color: "#2f5145", fontSize: 12, textDecorationLine: "underline" },
});
