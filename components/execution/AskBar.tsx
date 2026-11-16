import { Pressable, TextInput, View } from "react-native";
import { useTheme } from "../../theme";
import { T, Turtle } from "../ui";

export function AskBar({ value, onChangeText, onSend, busy, inputID, sendID, placeholder }: {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  inputID: string;
  sendID: string;
  placeholder: string;
}) {
  const { colors } = useTheme();
  const disabled = busy || !value.trim();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 6, gap: 4 }}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={() => { if (!disabled) onSend(); }}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        accessibilityLabel={placeholder}
        returnKeyType="send"
        testID={inputID}
        style={{ flex: 1, minWidth: 0, minHeight: 48, fontSize: 16, fontFamily: "Capriola_400Regular", fontWeight: "400", color: colors.text, paddingHorizontal: 10 }}
      />
      <Pressable
        onPress={onSend}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Ask turtl"
        accessibilityState={{ disabled }}
        testID={sendID}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 48, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.surfaceRaised, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}
      >
        <T variant="strong">Ask</T>
        <Turtle health="clear" size={26} />
      </Pressable>
    </View>
  );
}
