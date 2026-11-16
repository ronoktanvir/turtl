import { ConvexProvider } from "convex/react";
import { Stack, useSegments } from "expo-router";
import { useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";
import { ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { DevTools } from "../components/dev/DevTools";
import { ThemeProvider, useTheme } from "../theme";
import { useReducedMotion } from "../components/ui/motion";
import { useFonts, Capriola_400Regular } from "@expo-google-fonts/capriola";
import { Righteous_400Regular } from "@expo-google-fonts/righteous";
import { backendClient as convex, isLiveData, useDataStatus } from "../data";
import OwnerPasscodePrompt from "../components/ui/OwnerPasscodePrompt";

void SplashScreen.preventAutoHideAsync().catch(() => {});

function Screens() {
  const { colors, scheme } = useTheme();
  const reduced = useReducedMotion();
  const { errors } = useDataStatus();
  return (
    <>
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <Stack screenOptions={{ headerShown: false, animation: reduced ? "none" : "slide_from_right", animationDuration: 240, contentStyle: { backgroundColor: colors.bg } }} />
      {isLiveData && <OwnerPasscodePrompt />}
      {errors.length > 0 && <View testID="data-errors" style={{ maxHeight: 120, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
        <ScrollView><Text accessibilityRole="alert" style={{ fontSize: 14, lineHeight: 20, color: colors.statusAffected }}>{[...new Set(errors)].join("\n")}</Text></ScrollView>
      </View>}
    </>
  );
}

export default function RootLayout() {
  const first: string | undefined = useSegments()[0];
  const [fontsLoaded, fontError] = useFonts({ Capriola_400Regular, Righteous_400Regular });
  useEffect(() => {
    if (fontsLoaded || fontError) void SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);
  if (!fontsLoaded && !fontError) return null;

  if (!convex) {
    if (first !== "live" && first !== "case") {
      return (
        <ThemeProvider>
          <Screens />
        </ThemeProvider>
      );
    }
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>
          The backend URL is not configured. Set EXPO_PUBLIC_CONVEX_URL and
          restart the app.
        </Text>
      </View>
    );
  }

  return (
    <ThemeProvider>
      <ConvexProvider client={convex}>
        <Screens />
        <DevTools />
      </ConvexProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  missingText: { fontSize: 16, textAlign: "center" },
});
