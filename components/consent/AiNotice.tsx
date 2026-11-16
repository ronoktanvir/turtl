import { useRouter, type Href } from "expo-router";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { useAiPermission, type AiServiceId } from "../../data/consent";
import { useTheme } from "../../theme";
import { Icon, T } from "../ui";
import { listNames } from "./words";

// One line on a screen that depends on an AI service the owner has not allowed: what turtl cannot do, and the way
// to allow it. Nothing in the example build, the demo, or when everything it needs is allowed.
export default function AiNotice({ uses, cannot, testID = "ai-notice", style }: { uses: AiServiceId[]; cannot: string; testID?: string; style?: StyleProp<ViewStyle> }) {
  const status = useAiPermission();
  const router = useRouter();
  const { colors } = useTheme();
  if (!status?.enforced || !status.signedIn) return null;
  const blocked = status.services.filter((service) => uses.includes(service.id as AiServiceId) && !service.allowed);
  if (!blocked.length) return null;
  const line = `turtl can't ${cannot} until you allow ${listNames(blocked.map((service) => service.name))}.`;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${line} Open the AI permission to allow it.`}
      onPress={() => router.push("/ai-permission" as Href)}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, borderWidth: 1, borderColor: colors.statusNeedsYou, backgroundColor: pressed ? colors.surfaceRaised : colors.surface }, style]}
    >
      <Icon name="Info" size={18} color="statusNeedsYou" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="small">{line}</T>
      </View>
      <T variant="small" color="link">Allow</T>
    </Pressable>
  );
}
