import { useRouter, useSegments } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useProjects } from "../../data";
import { PUSH_EXPLAINED, useKeepPushFresh, useNotificationTaps, usePush, type PushView } from "../../data/push";
import { Button, Sheet, T } from "../ui";

// Mounted once in app/_layout.tsx. Opens the case when the owner taps a notification, keeps this phone's token
// current, and offers notifications once, on the projects screens, the first time a project exists.
// It never asks at launch, and renders nothing in the demo or the example build.

function Offer({ push, onClose }: { push: PushView; onClose: () => void }) {
  const projects = useProjects();
  const first: string | undefined = useSegments()[0];
  const visible = !!projects?.length && (first === "projects" || first === "project");
  const close = () => { void push.dismissOffer(); onClose(); };
  const answered = !!push.message && !push.busy;
  return (
    <Sheet visible={visible} onClose={close} title="Get notified when a case needs you" testID="push-offer">
      <View style={{ gap: 16 }}>
        <T>{PUSH_EXPLAINED}</T>
        <T color="textMuted">You can change this any time under Settings. turtl works the same without notifications.</T>
        {push.message && <T accessibilityRole="alert" testID="push-offer-message">{push.message}</T>}
        {!answered && <Button label={push.busy ? "Turning on…" : "Turn on notifications"} disabled={push.busy} onPress={() => void push.turnOn()} testID="push-offer-accept" />}
        <Button label={answered ? "Close" : "Not now"} kind="plain" disabled={push.busy} onPress={close} testID="push-offer-later" />
      </View>
    </Sheet>
  );
}

export default function PushNotifications() {
  const router = useRouter();
  const push = usePush();
  const open = useCallback((caseId: string) => router.push(`/review/${caseId}`), [router]);
  useNotificationTaps(open);
  useKeepPushFresh(push.kind === "on" || push.kind === "off" || push.kind === "blocked");
  // Once shown, the offer stays until the owner closes it, so a refusal or an error can be read; turning on closes it.
  const [offering, setOffering] = useState(false);
  useEffect(() => { if (push.offer) setOffering(true); }, [push.offer]);
  useEffect(() => { if (push.kind === "on") setOffering(false); }, [push.kind]);
  return offering ? <Offer push={push} onClose={() => setOffering(false)} /> : null;
}
