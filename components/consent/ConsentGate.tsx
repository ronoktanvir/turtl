import { useRootNavigationState, useRouter, useSegments, type Href } from "expo-router";
import { useEffect } from "react";
import { useAiPermission } from "../../data/consent";
import { isLiveData } from "../../data/source";

// Sends a signed-in owner to the AI permission screen before they first use turtl, and again when the list of
// services changes. It renders nothing. It never acts in the example build, in the single-owner demo (the backend
// says enforced is false), or before sign-in; the backend refuses to send anything either way.
export default function ConsentGate() {
  return isLiveData ? <LiveGate /> : null;
}

function LiveGate() {
  const status = useAiPermission();
  const router = useRouter();
  const ready = !!useRootNavigationState()?.key;
  const first = useSegments()[0] as string | undefined;
  const ask = !!status?.enforced && status.signedIn && status.needsAnswer;
  useEffect(() => {
    // Only once the navigator is mounted, and not from the sign-in screen (index), which moves on by itself once
    // someone signs in.
    if (ready && ask && first !== undefined && first !== "ai-permission") router.replace("/ai-permission?from=start" as Href);
  }, [ready, ask, first]);
  return null;
}
