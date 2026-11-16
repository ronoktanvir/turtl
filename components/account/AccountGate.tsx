import { useRootNavigationState, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useAccount } from "../../data/account";
import { gateTarget, holdScreens } from "../../data/account/status";
import { isStoreBuild } from "../../data/source";
import { useTheme } from "../../theme";
import AccountsOff from "./AccountsOff";

/** With accounts on, only Login and its forms open signed out; signing in lands on Projects and signing out returns
 * to Login. In the demo it does nothing. Rendered beside the screens, so it covers them while it redirects. */
export default function AccountGate() {
  const { status, mode } = useAccount();
  const first: string | undefined = useSegments()[0];
  const router = useRouter();
  const ready = Boolean(useRootNavigationState()?.key);
  const { colors } = useTheme();
  const target = gateTarget(status, first);
  useEffect(() => {
    if (!target || !ready) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace(target);
  }, [target, ready]);
  if (status === "accountsOff") return <AccountsOff />;
  if (!target && !holdScreens(status, isStoreBuild, mode)) return null;
  return <View testID="account-gate" accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />;
}
