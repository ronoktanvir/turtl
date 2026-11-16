import { useRouter } from "expo-router";
import { Image, View } from "react-native";
import { Button, Screen, T } from "../components/ui";

export default function NotFound() {
  const router = useRouter();
  return (
    <Screen testID="not-found">
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 14, paddingHorizontal: 28, paddingBottom: 40 }}>
        <Image source={require("../assets/turtle/detective.png")} style={{ width: 112, height: 112 }} resizeMode="contain" accessibilityLabel="turtl" />
        <T variant="title" accessibilityRole="header" style={{ textAlign: "center", marginTop: 8 }}>turtl can't find that page</T>
        <T color="textMuted" style={{ textAlign: "center", maxWidth: 340 }}>The link may be old, or what it pointed to is no longer here.</T>
        <Button label="Go to Projects" onPress={() => router.replace("/projects")} testID="not-found-projects" style={{ width: "100%", maxWidth: 340, minHeight: 52, borderRadius: 16, marginTop: 12 }} />
      </View>
    </Screen>
  );
}
