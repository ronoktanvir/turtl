import { TextInput } from "react-native";
import { useTheme } from "../../theme";

/** A one-line field for a token or key. What is typed is hidden, never autocorrected, and never read back from turtl. */
export function SecretInput({
  label,
  placeholder,
  value,
  onChangeText,
  editable,
  testID,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  editable: boolean;
  testID: string;
}) {
  const { colors } = useTheme();
  return (
    <TextInput
      accessibilityLabel={label}
      testID={testID}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      textContentType="none"
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      style={{ color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16, fontFamily: "Capriola_400Regular", fontWeight: "400" }}
    />
  );
}
