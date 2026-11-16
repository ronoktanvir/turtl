import { useRouter } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandIcon, Button, Logo, Reveal, Screen, T } from "../components/ui";
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
          <Reveal><Logo health="clear" width={240} /></Reveal>
        </View>
        <Reveal delay={100} style={{ gap: 12, width: "100%", maxWidth: 400, alignSelf: "center" }}>
          <Button label="Login" testID="login-enter" onPress={enter} style={{ minHeight: 52, borderRadius: 16 }} />
          <View style={{ flexDirection: "row", gap: 12 }}>
            {(["github", "google"] as const).map((provider) => (
              <Pressable key={provider} testID={`login-${provider}`} accessibilityRole="button" accessibilityLabel={provider === "github" ? "Login with GitHub" : "Login with Google"} onPress={enter} style={({ pressed }) => ({ flex: 1, minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: 16, flexDirection: "row", gap: 10, justifyContent: "center", alignItems: "center", backgroundColor: pressed ? colors.surfaceRaised : colors.surface })}>
                <BrandIcon name={provider} size={20} />
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
