import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ServiceCard from "../components/consent/ServiceCard";
import { day, listNames, whatItDoes } from "../components/consent/words";
import LegalLinks from "../components/legal/LegalLinks";
import { Button, Header, Screen, T } from "../components/ui";
import { allowAi, declineAi, useAiPermission, withdrawAi } from "../data/consent";
import { useTheme } from "../theme";

// The AI permission: each outside AI service, what it does for turtl and what it receives, read from
// store/data-practices.json through the backend, and a yes or a not now. ConsentGate brings a signed-in owner here
// before first use (?from=start); the gear sheet brings them back to read it again or take it back.
export default function AiPermission() {
  const status = useAiPermission();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const atStart = from === "start";
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  const leave = () => (atStart || !router.canGoBack() ? router.replace("/projects" as Href) : router.back());
  const run = async (work: () => Promise<void>, after: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      after();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "turtl could not save your answer. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const body = (() => {
    if (status === undefined) return <T color="textMuted">Loading…</T>;
    if (status === null) {
      return (
        <View style={{ gap: 16 }}>
          <T>turtl could not load the list of services. Check your connection, then try again.</T>
          <Button label="Back" kind="outline" onPress={leave} testID="ai-permission-back" />
        </View>
      );
    }

    // After a no: what turtl still does, and what it cannot do without these services.
    if (declined) {
      return (
        <View style={{ gap: 16 }} testID="ai-permission-declined">
          <T variant="title" accessibilityRole="header">turtl will work without AI</T>
          <T>turtl still watches your app, runs its checks, and offers the recovery steps you set up, using its own rules. It sends nothing to:</T>
          <View style={{ gap: 8 }}>
            {status.services.map((service) => (
              <View key={service.id} style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ width: 5, height: 5, borderRadius: 3, marginTop: 10, backgroundColor: colors.statusNeedsYou }} />
                <T style={{ flex: 1 }}>{whatItDoes(service)}.</T>
              </View>
            ))}
          </View>
          <T color="textMuted">So turtl can't do those things for you until you allow them. You can do that at any time in Settings.</T>
          <Button label="Continue" onPress={leave} testID="ai-permission-continue" />
        </View>
      );
    }

    const current = status.answer === "allowed" && status.services.every((service) => service.allowed);
    const answered =
      status.answer === "allowed" && current
        ? `You allowed this${status.answeredAt ? ` on ${day(status.answeredAt)}` : ""}.`
        : status.answer === "allowed"
          ? "turtl's list changed after you agreed. Read it again, then choose."
          : status.answer === "withdrawn"
            ? `You took permission back${status.withdrawnAt ? ` on ${day(status.withdrawnAt)}` : ""}. turtl sends nothing to these services.`
            : status.answer === "declined"
              ? "You chose Not now. turtl sends nothing to these services."
              : null;
    return (
      <View style={{ gap: 16 }}>
        <T variant="title" accessibilityRole="header">Before turtl uses AI</T>
        <T>To find out what broke and how to fix it, turtl sends some of your project's data to the services below. Nothing goes to them until you allow it, and you can take it back at any time in Settings.</T>
        {answered && <T color="statusNeedsYou" testID="ai-permission-answered">{answered}</T>}
        {status.services.map((service) => <ServiceCard key={service.id} service={service} />)}
        {status.alsoUsed.length > 0 && (
          <T variant="small" color="textMuted" testID="ai-permission-also-used">
            turtl also needs {listNames(status.alsoUsed.map((service) => service.name))} to run at all, so it does not ask about them. The privacy policy says what each one receives.
          </T>
        )}
        {error && <T color="statusAffected" accessibilityRole="alert">{error}</T>}
        {current ? (
          <View style={{ gap: 10 }}>
            <Button label="Done" onPress={leave} testID="ai-permission-done" />
            <Button label="Take back permission" kind="danger" disabled={busy} onPress={() => void run(withdrawAi, leave)} testID="ai-permission-withdraw" />
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <Button label={busy ? "Saving…" : "Allow"} disabled={busy} onPress={() => void run(() => allowAi(status.listVersion), leave)} testID="ai-permission-allow" />
            <Button label="Not now" kind="plain" disabled={busy} onPress={() => void run(() => declineAi(status.listVersion), () => setDeclined(true))} testID="ai-permission-not-now" />
          </View>
        )}
        <LegalLinks />
      </View>
    );
  })();

  return (
    <Screen testID="ai-permission">
      <Header title="AI services" fallback={atStart ? undefined : ("/projects" as Href)} testID="ai-permission-title" />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: insets.bottom + 40 }}>{body}</ScrollView>
    </Screen>
  );
}
