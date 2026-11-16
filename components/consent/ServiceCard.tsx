import { Linking, Pressable, View } from "react-native";
import type { AiService } from "../../data/consent";
import { useTheme } from "../../theme";
import { Card, Chip, Icon, T } from "../ui";

// One outside service on the permission screen: what it does for turtl and what it receives, word for word from
// store/data-practices.json, and a link to its own privacy policy.
export default function ServiceCard({ service }: { service: AiService }) {
  const { colors } = useTheme();
  return (
    <Card testID={`ai-service-${service.id}`} style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T variant="heading" style={{ flex: 1 }}>{service.name}</T>
        {service.allowed && <Chip label="Allowed" tone="statusClear" testID={`ai-service-${service.id}-allowed`} />}
      </View>
      <T color="textMuted">{service.does}.</T>
      <View style={{ gap: 6 }} accessibilityLabel={`What ${service.name} receives: ${service.receives.join(", ")}`}>
        <T variant="strong">What it receives</T>
        {service.receives.map((item) => (
          <View key={item} style={{ flexDirection: "row", gap: 8, paddingLeft: 2 }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, marginTop: 10, backgroundColor: colors.brandDeep }} />
            <T style={{ flex: 1 }}>{item}</T>
          </View>
        ))}
      </View>
      {!!service.policy && (
        <Pressable
          testID={`ai-service-${service.id}-policy`}
          accessibilityRole="link"
          accessibilityLabel={`${service.name}'s privacy policy`}
          onPress={() => void Linking.openURL(service.policy)}
          style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}
        >
          <Icon name="ExternalLink" size={15} color="textMuted" />
          <T variant="small" color="textMuted">{service.name}'s privacy policy</T>
        </Pressable>
      )}
    </Card>
  );
}
