import { UserRound } from "lucide-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { useAccount } from "../../data/account";
import { realSignIn } from "../../data/account/status";
import { isStoreBuild } from "../../data/source";
import { useTheme } from "../../theme";

// The demo's photo. A preview or production build never bundles it: Metro inlines EXPO_PUBLIC_APP_ENV and drops
// this require when the comparison is true (checklist RC-04).
const demoPhoto: number | null =
  process.env.EXPO_PUBLIC_APP_ENV === "preview" || process.env.EXPO_PUBLIC_APP_ENV === "production" ? null : require("../../assets/brand/ronok-avatar.png");

/** The signed-in person's picture, or a neutral placeholder. Without accounts, the demo's photo as before. */
export default function ProfilePicture({ size = 40 }: { size?: number }) {
  const { mode, viewer } = useAccount();
  const { colors } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const frame = { width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: colors.border };
  if (demoPhoto !== null && !realSignIn(isStoreBuild, mode)) return <Image source={demoPhoto} accessibilityLabel="Your profile" style={frame} />;
  // A picture that will not load (offline, or removed on GitHub) falls back to the placeholder.
  if (viewer?.picture && failed !== viewer.picture) {
    const picture = viewer.picture;
    return <Image testID="profile-picture" source={{ uri: picture }} onError={() => setFailed(picture)} accessibilityLabel="Your profile picture" style={frame} />;
  }
  return (
    <View testID="profile-placeholder" accessible accessibilityRole="image" accessibilityLabel="Your profile" style={[frame, { alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceRaised }]}>
      <UserRound size={size * 0.5} strokeWidth={1.7} color={colors.textMuted} />
    </View>
  );
}
