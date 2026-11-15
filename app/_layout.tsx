import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { DevTools } from "../components/dev/DevTools";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const convex = convexUrl
  ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false })
  : null;

export default function RootLayout() {
  if (!convex) {
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
    <ConvexProvider client={convex}>
      <Stack screenOptions={{ headerShown: false }} />
      <DevTools />
    </ConvexProvider>
  );
}

const styles = StyleSheet.create({
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  missingText: { fontSize: 16, textAlign: "center" },
});
