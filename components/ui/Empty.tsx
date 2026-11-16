import { View } from "react-native";
import type { Health } from "../../data/types";
import { Button, T, Turtle } from ".";

/**
 * What a screen shows when it has nothing yet: the turtle, one line saying so, a line on what will appear
 * here, and one way on. It fills the space under the header and centres itself, like the Fix list with
 * nothing in it.
 */
export function Empty({ health = "clear", message, hint, action, testID }: {
  health?: Health;
  message: string;
  hint?: string;
  action?: { label: string; onPress: () => void; testID: string };
  testID?: string;
}) {
  return (
    <View testID={testID} style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 28, paddingBottom: 40 }}>
      <Turtle health={health} size={96} />
      <T variant="strong" color="textMuted" style={{ textAlign: "center", maxWidth: 320 }}>{message}</T>
      {hint && <T variant="small" color="textMuted" style={{ textAlign: "center", maxWidth: 320 }}>{hint}</T>}
      {action && <Button label={action.label} kind="outline" onPress={action.onPress} testID={action.testID} style={{ width: "100%", maxWidth: 340, marginTop: 8 }} />}
    </View>
  );
}
