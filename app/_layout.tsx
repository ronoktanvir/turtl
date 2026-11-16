import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Stack, useSegments } from "expo-router";
import { StatusBar, StyleSheet, Text, View } from "react-native";
import { DevTools } from "../components/dev/DevTools";
import { ThemeProvider, useTheme } from "../theme";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const convex = convexUrl
  ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false })
  : null;

function Screens() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </>
  );
}

export default function RootLayout() {
  const first: string | undefined = useSegments()[0];

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
