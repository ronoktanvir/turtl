import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { Logo, T } from ".";

const words = {
  unreachable: {
    title: "Can't reach turtl",
    body: "Check your internet connection. turtl keeps trying and will carry on from here once it is back.",
  },
  misconfigured: {
    title: "This version of turtl can't connect",
    body: "Install the latest version from the App Store.",
  },
};

export default function BackendUnavailable({ reason }: { reason: keyof typeof words }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID={`backend-${reason}`} accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 28, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Logo health="clear" width={200} />
      <T variant="heading" accessibilityRole="alert" style={{ textAlign: "center", marginTop: 18 }}>{words[reason].title}</T>
      <T color="textMuted" style={{ textAlign: "center", maxWidth: 320 }}>{words[reason].body}</T>
    </View>
  );
}
