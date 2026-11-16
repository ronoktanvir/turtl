import { Linking, Pressable, View } from "react-native";
import { Icon, T } from "../ui";
import { legalLinks } from "./links";

export default function LegalLinks() {
  return <View testID="legal-links" style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 20 }}>
    {legalLinks.map((link) => <Pressable key={link.id} testID={`legal-${link.id}`} accessibilityRole="link" onPress={() => void Linking.openURL(link.url)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name="ExternalLink" size={15} color="textMuted" />
      <T variant="small" color="textMuted">{link.label}</T>
    </Pressable>)}
  </View>;
}
