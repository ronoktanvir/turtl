import { Image, View, type ImageSourcePropType } from "react-native";
import type { Project } from "../../data/types";
import { useTheme } from "../../theme";
import { T } from "../ui";

const projectImages: Record<string, ImageSourcePropType> = {
  "still-booking-demo": require("../../assets/projects/still-booking.png"),
  guardian: require("../../assets/projects/guardian.png"),
  "tide-journal": require("../../assets/projects/tide-journal.png"),
};

export default function ProjectIcon({ project, size = 48 }: { project: Project; size?: number }) {
  const { colors } = useTheme();
  const source = projectImages[project.id] ?? (project.iconUrl ? { uri: project.iconUrl } : undefined);
  if (source) {
    return (
      <Image
        source={source}
        style={{ width: size, height: size, borderRadius: size / 4 }}
        accessibilityLabel={project.name + " icon"}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 3.5,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceRaised,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T variant="heading" color="brandDeep" style={{ fontSize: size * 0.42, lineHeight: size * 0.6 }}>{project.name.charAt(0).toUpperCase()}</T>
    </View>
  );
}
