import { router, type ErrorBoundaryProps } from "expo-router";
import { Image, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { devToolsAllowed } from "../../data/source";
import { ThemeProvider, useTheme } from "../../theme";
import { Button, T } from ".";

// What a screen shows when it fails to draw, instead of a blank page. app/_layout.tsx exports it as the root
// ErrorBoundary, so it replaces the whole layout and brings its own theme. Only development builds show the error.

function Message({ error, retry }: ErrorBoundaryProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const home = () => {
    // Move the navigation off the failing screen first, then draw the layout again.
    try { router.replace("/projects"); } catch {}
    void retry();
  };
  return (
    <View testID="screen-error" style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", gap: 14, paddingHorizontal: 28, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
        <Image source={require("../../assets/turtle/needs_you.png")} style={{ width: 112, height: 112 }} resizeMode="contain" accessibilityLabel="turtl" />
        <T variant="title" accessibilityRole="alert" style={{ textAlign: "center", marginTop: 8 }}>This screen didn't load</T>
        <T color="textMuted" style={{ textAlign: "center", maxWidth: 340 }}>Something went wrong while turtl was drawing it. Try again, or go back to your projects.</T>
        <View style={{ width: "100%", maxWidth: 340, gap: 12, marginTop: 12 }}>
          <Button label="Try again" onPress={() => void retry()} testID="screen-error-retry" style={{ minHeight: 52, borderRadius: 16 }} />
          <Button label="Go to Projects" kind="outline" onPress={home} testID="screen-error-projects" style={{ minHeight: 52, borderRadius: 16 }} />
        </View>
        {devToolsAllowed && <T variant="mono" color="textMuted" testID="screen-error-detail" style={{ fontSize: 12, marginTop: 16, maxWidth: 340 }} numberOfLines={6}>{error.message}</T>}
      </ScrollView>
    </View>
  );
}

export function ScreenError(props: ErrorBoundaryProps) {
  return <ThemeProvider><Message {...props} /></ThemeProvider>;
}
