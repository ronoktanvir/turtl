import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { Logo, T } from "../ui";

/** A store build pointed at a backend with sign-in switched off refuses to run (checklist RC-04). */
export default function AccountsOff() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID="accounts-off" accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 28, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Logo health="clear" width={200} />
      <T variant="heading" accessibilityRole="alert" style={{ textAlign: "center", marginTop: 18 }}>turtl can't open right now</T>
      <T color="textMuted" style={{ textAlign: "center", maxWidth: 320 }}>
        turtl's server has sign-in switched off, so this app won't open: without it, anyone could see your projects. This is a problem on turtl's side, not yours. Try again later.
      </T>
    </View>
  );
}
