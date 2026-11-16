import { Image, View } from "react-native";
import type { Project } from "../../data/types";
import { useTheme } from "../../theme";
import { T } from "../ui";

export default function ProjectIcon({ project, size = 48 }: { project: Project; size?: number }) {
  const { colors } = useTheme();
  if (project.iconUrl) {
    return (
      <Image
        source={{ uri: project.iconUrl }}
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
