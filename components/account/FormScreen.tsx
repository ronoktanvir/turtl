import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Header, Screen, T } from "../ui";

/** The frame of the sign-in, sign-up and reset forms: a header with Back to Login, and a scrolling form. `back={false}`
 * for a screen with nowhere to go back to (Check your email). */
export default function FormScreen({ title, testID, back = true, children }: { title: string; testID: string; back?: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Screen testID={testID}>
      <Header title={title} {...(back && { fallback: "/" as const })} testID={`${testID}-title`} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: insets.bottom + 40, width: "100%", maxWidth: 440, alignSelf: "center" }}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** A quiet text link inside a form. `role="button"` when it acts (signs out) rather than opens another screen. */
export function FormLink({ label, onPress, testID, role = "link", disabled }: { label: string; onPress: () => void; testID: string; role?: "link" | "button"; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole={role} accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID} hitSlop={6} style={{ minHeight: 44, justifyContent: "center", alignSelf: "center", opacity: disabled ? 0.65 : 1 }}>
      <T color="link" style={{ textAlign: "center" }}>{label}</T>
    </Pressable>
  );
}
