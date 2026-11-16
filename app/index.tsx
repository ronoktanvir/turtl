import { useRouter } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Button, Icon, Logo, Reveal, Screen, T } from "../components/ui";
import { useTheme } from "../theme";

export default function Login() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const enter = () => router.replace("/projects");
  return (
    <Screen testID="login">
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, paddingBottom: insets.bottom + 24 }}>
        <View style={{ flex: 1, minHeight: 340, alignItems: "center", justifyContent: "center", paddingVertical: 28 }}>
          <Reveal style={{ width: "100%", alignItems: "center" }}>
            <View style={{ height: 220, width: "100%", alignItems: "center", justifyContent: "center" }}>
              <View pointerEvents="none" style={{ position: "absolute", width: 286, height: 286, borderRadius: 143, borderWidth: 1, borderColor: colors.brandDeep, opacity: 0.16, transform: [{ scaleY: 0.72 }, { rotate: "-24deg" }] }} />
              <View pointerEvents="none" style={{ position: "absolute", width: 238, height: 238, borderRadius: 119, borderWidth: 1, borderColor: colors.brandDeep, opacity: 0.22, transform: [{ scaleY: 0.8 }, { rotate: "24deg" }] }} />
              <View pointerEvents="none" style={{ position: "absolute", top: 22, right: "20%", width: 7, height: 7, borderRadius: 4, backgroundColor: colors.brandDeep }} />
              <Logo health="clear" width={240} />
            </View>
            <T variant="title" style={{ textAlign: "center", marginTop: 12 }}>A little calm for your code.</T>
            <T color="textMuted" style={{ textAlign: "center", maxWidth: 290, marginTop: 12 }}>Understand what happened. Choose what happens next.</T>
          </Reveal>
        </View>
        <Reveal delay={100} style={{ gap: 12, width: "100%", maxWidth: 400, alignSelf: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 4 }}>
            <Icon name="ShieldCheck" size={15} color="textMuted" />
            <T variant="small" color="textMuted">A guided demo. No account needed.</T>
          </View>
          <Button label="Login" testID="login-enter" onPress={enter} style={{ minHeight: 52, borderRadius: 16 }} />
          <View style={{ flexDirection: "row", gap: 12 }}>
            {(["github", "google"] as const).map((provider) => (
              <Pressable key={provider} testID={`login-${provider}`} accessibilityRole="button" accessibilityLabel={provider === "github" ? "Login with GitHub" : "Login with Google"} onPress={enter} style={({ pressed }) => ({ flex: 1, minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: 16, flexDirection: "row", gap: 10, justifyContent: "center", alignItems: "center", backgroundColor: pressed ? colors.surfaceRaised : colors.surface })}>
                {provider === "github" ? <Svg width={20} height={20} viewBox="0 0 24 24"><Path fill={colors.text} d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.81c.85 0 1.71.12 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" /></Svg> : <Svg width={19} height={19} viewBox="0 0 24 24"><Path fill={colors.text} d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36ZM12 22c2.7 0 4.96-.9 6.61-2.41l-3.23-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.58-4.12H3.08v2.59A10 10 0 0 0 12 22ZM6.42 13.92a6 6 0 0 1 0-3.84V7.49H3.08a10 10 0 0 0 0 9.02l3.34-2.59ZM12 5.96c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.92 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z" /></Svg>}
                <T variant="strong">{provider === "github" ? "GitHub" : "Google"}</T>
              </Pressable>
            ))}
          </View>
          <Button label="Sign up" kind="plain" testID="login-signup" onPress={enter} style={{ minHeight: 50, borderRadius: 16, backgroundColor: colors.bg, borderColor: colors.bg }} />
        </Reveal>
      </ScrollView>
    </Screen>
  );
}
