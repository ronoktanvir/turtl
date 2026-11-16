import { Image, View, useWindowDimensions } from "react-native";
import { useTheme } from "../../theme";
import { Button, Icon, Reveal, T, type IconName } from "../ui";

// Home before the first project: what turtl does, and one way forward. Nothing here should read as an error.

const lines: { icon: IconName; text: string }[] = [
  { icon: "ShieldCheck", text: "turtl watches the parts of your app that must never break." },
  { icon: "Search", text: "When one breaks, it finds out why and suggests fixes in plain words." },
  { icon: "Check", text: "It changes nothing until you approve a fix, then shows you it worked." },
];

export default function FirstRun({ onAdd }: { onAdd: () => void }) {
  const { colors } = useTheme();
  const small = useWindowDimensions().height < 700;
  const size = small ? 88 : 128;
  return (
    <View testID="first-run" style={{ gap: small ? 20 : 28, paddingTop: small ? 0 : 8 }}>
      <Reveal style={{ alignItems: "center", gap: small ? 10 : 16 }}>
        <Image source={require("../../assets/turtle/detective.png")} style={{ width: size, height: size }} resizeMode="contain" accessibilityLabel="turtl, ready to look after your app" />
        <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>Let turtl keep watch</T>
      </Reveal>
      <Reveal delay={80} style={{ gap: small ? 12 : 16 }}>
        {lines.map((line, index) => (
          <View key={line.icon} testID={"first-run-line-" + index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }}>
              <Icon name={line.icon} size={18} color="brandDeep" />
            </View>
            <T style={{ flex: 1, paddingTop: 6 }}>{line.text}</T>
          </View>
        ))}
      </Reveal>
      <Reveal delay={160} style={{ gap: 12 }}>
        <Button label="Add your first project" icon="Plus" onPress={onAdd} testID="first-run-add-project" style={{ minHeight: 52, borderRadius: 16 }} />
        <T variant="small" color="textMuted" style={{ textAlign: "center" }}>You'll need its GitHub repository. The address of the live app helps too.</T>
      </Reveal>
    </View>
  );
}
