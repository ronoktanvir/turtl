import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DeleteAccountNotice from "../components/account/DeleteAccountNotice";
import LegalLinks from "../components/legal/LegalLinks";
import { BrandIcon, Button, Logo, Reveal, Screen, T } from "../components/ui";
import { useAccount, useAccountActions } from "../data/account";
import { realSignIn } from "../data/account/status";
import { isStoreBuild } from "../data";
import { useTheme } from "../theme";

const providers = [
  { id: "apple", label: "Apple", a11y: "Sign in with Apple" },
  { id: "github", label: "GitHub", a11y: "Sign in with GitHub" },
] as const;

export default function Login() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { mode } = useAccount();
  const actions = useAccountActions();
  const pending = useRef(false);
  const [busy, setBusy] = useState<(typeof providers)[number]["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Without accounts (the demo) every button is a demonstration control that opens Home.
  const real = realSignIn(isStoreBuild, mode);
  const enter = () => router.replace("/projects");
  const open = (path: "/sign-in" | "/sign-up") => (real ? router.push(path) : enter());
  const withProvider = async (id: (typeof providers)[number]["id"]) => {
    if (!real) return enter();
    if (pending.current) return;
    pending.current = true;
    setBusy(id);
    setError(null);
    const message = await actions[id]();
    pending.current = false;
    setBusy(null);
    setError(message);
  };
  return (
    <Screen testID="login">
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, paddingBottom: insets.bottom + 24 }}>
        <View style={{ flex: 1, minHeight: 340, alignItems: "center", justifyContent: "center", paddingVertical: 28 }}>
          <Reveal><Logo health="clear" width={240} /></Reveal>
        </View>
        <Reveal delay={100} style={{ gap: 12, width: "100%", maxWidth: 400, alignSelf: "center" }}>
          <DeleteAccountNotice />
          <Button label="Log in" testID="login-enter" onPress={() => open("/sign-in")} style={{ minHeight: 52, borderRadius: 16 }} />
          <View style={{ flexDirection: "row", gap: 12 }}>
            {providers.map((provider) => (
              <Pressable key={provider.id} testID={`login-${provider.id}`} accessibilityRole="button" accessibilityLabel={provider.a11y} accessibilityState={{ busy: busy === provider.id, disabled: busy !== null }} disabled={busy !== null} onPress={() => void withProvider(provider.id)} style={({ pressed }) => ({ flex: 1, minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: 16, flexDirection: "row", gap: 10, justifyContent: "center", alignItems: "center", backgroundColor: pressed ? colors.surfaceRaised : colors.surface, opacity: busy !== null && busy !== provider.id ? 0.65 : 1 })}>
                <BrandIcon name={provider.id} size={20} />
                <T variant="strong">{busy === provider.id ? "Opening…" : provider.label}</T>
              </Pressable>
            ))}
          </View>
          {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="login-error" style={{ textAlign: "center" }}>{error}</T>}
          <Button label="Sign up" kind="plain" testID="login-signup" onPress={() => open("/sign-up")} style={{ minHeight: 50, borderRadius: 16, backgroundColor: colors.bg, borderColor: colors.bg }} />
          <LegalLinks />
        </Reveal>
      </ScrollView>
    </Screen>
  );
}
