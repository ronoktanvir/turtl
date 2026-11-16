import { TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../../theme";
import { T } from "../ui";

/** A labelled text field for the sign-in forms, styled like the app's other forms. `code` for an emailed code: a
 * little smaller, so all of ABCDE-FGHJK-MNPQR-STVWX fits on a 320-point screen. */
export default function Field({ label, hint, testID, code, ...input }: TextInputProps & { label: string; hint?: string; testID: string; code?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <T variant="strong">{label}</T>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        testID={testID}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.textMuted}
        {...input}
        style={{ color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, paddingHorizontal: code ? 10 : 14, fontSize: code ? 14 : 16, fontFamily: "Capriola_400Regular" }}
      />
      {hint && <T variant="small" color="textMuted">{hint}</T>}
    </View>
  );
}
