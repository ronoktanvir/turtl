import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Header, Screen, T } from "../ui";

/** The frame of the sign-in, sign-up and reset forms: a header with Back to Login, and a scrolling form. */
export default function FormScreen({ title, testID, children }: { title: string; testID: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Screen testID={testID}>
      <Header title={title} fallback="/" testID={`${testID}-title`} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: insets.bottom + 40, width: "100%", maxWidth: 440, alignSelf: "center" }}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** A quiet text link inside a form. */
export function FormLink({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" testID={testID} hitSlop={6} style={{ minHeight: 44, justifyContent: "center", alignSelf: "center" }}>
      <T color="link">{label}</T>
    </Pressable>
  );
}
