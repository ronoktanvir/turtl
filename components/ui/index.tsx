import { useRouter, type Href } from "expo-router";
import type { ReactNode } from "react";
import {
  Image,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Health } from "../../data/types";
import { healthToken, healthWord, useTheme, type TokenName } from "../../theme";

export const devToolsOn =
  !!process.env.EXPO_PUBLIC_CONVEX_URL && (__DEV__ || process.env.EXPO_PUBLIC_DEV_TOOLS === "1");

const turtles: Record<Health, number> = {
  affected: require("../../assets/turtle/affected.png"),
  needs_you: require("../../assets/turtle/needs_you.png"),
  working: require("../../assets/turtle/working.png"),
  clear: require("../../assets/turtle/clear.png"),
};

const logos: Record<Health, number> = {
  affected: require("../../assets/brand/logo-affected.png"),
  needs_you: require("../../assets/brand/logo-needs_you.png"),
  working: require("../../assets/brand/logo-working.png"),
  clear: require("../../assets/brand/logo-clear.png"),
};

const variants = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "700" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  strong: { fontSize: 16, lineHeight: 24, fontWeight: "600" },
  small: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  mono: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" }),
  },
} satisfies Record<string, TextStyle>;

export function T({
  variant = "body",
  color = "text",
  style,
  ...props
}: TextProps & { variant?: keyof typeof variants; color?: TokenName }) {
  const { colors } = useTheme();
  return <Text {...props} style={[variants[variant], { color: colors[color] }, style]} />;
}

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }} testID={testID}>
      {children}
    </View>
  );
}

export function Header({
  title,
  fallback,
  right,
  testID,
}: {
  title: string;
  fallback?: Href;
  right?: ReactNode;
  testID?: string;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      {fallback && (
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback))}
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="header-back"
          hitSlop={8}
          style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <T variant="display" color="textMuted" style={{ lineHeight: 34 }}>
            ‹
          </T>
        </Pressable>
      )}
      <T variant="heading" style={{ flex: 1 }} numberOfLines={2} testID={testID} accessibilityRole="header">
        {title}
      </T>
      {right}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "outline" | "plain" | "danger";
  disabled?: boolean;
  testID: string | undefined;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const look: Record<typeof kind, { bg: string; border: string; text: TokenName }> = {
    primary: { bg: colors.brand, border: colors.brand, text: "onBrand" },
    outline: { bg: "transparent", border: colors.brandDeep, text: "text" },
    plain: { bg: colors.surfaceRaised, border: colors.border, text: "text" },
    danger: { bg: "transparent", border: colors.statusAffected, text: "statusAffected" },
  };
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      style={({ pressed }) => [
        {
          minHeight: 48,
          paddingHorizontal: 18,
          borderRadius: 12,
          borderWidth: 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: look[kind].bg,
          borderColor: look[kind].border,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      <T variant="strong" color={look[kind].text}>
        {label}
      </T>
    </Pressable>
  );
}

export function Chip({ label, tone = "textMuted", testID }: { label: string; tone?: TokenName; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderWidth: 1,
        borderColor: colors[tone],
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 2,
      }}
      testID={testID}
    >
      <T variant="small" color={tone} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </View>
  );
}

export function Card({
  children,
  onPress,
  testID,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const base: ViewStyle = {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  };
  if (!onPress) {
    return (
      <View style={[base, style]} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [base, pressed && { backgroundColor: colors.surfaceRaised }, style]}
    >
      {children}
    </Pressable>
  );
}

export function Turtle({ health, size = 40, outlined }: { health: Health; size?: number; outlined?: boolean }) {
  const { colors } = useTheme();
  const image = (
    <Image
      source={turtles[health]}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel={"turtl: " + healthWord[health]}
    />
  );
  if (!outlined) return image;
  return (
    <View style={{ borderWidth: 2, borderColor: colors[healthToken[health]], borderRadius: size, padding: 6 }}>
      {image}
    </View>
  );
}

export function Logo({ health, width = 200 }: { health: Health; width?: number }) {
  return (
    <Image
      source={logos[health]}
      style={{ width, height: Math.round((width * 265) / 840) }}
      resizeMode="contain"
      accessibilityLabel={"turtl. " + healthWord[health]}
    />
  );
}

export function HealthWord({ health, testID }: { health: Health; testID?: string }) {
  const urgent = health === "affected" || health === "needs_you";
  return (
    <T variant="small" color={healthToken[health]} style={{ fontWeight: "700" }} testID={testID}>
      {(urgent ? "! " : "") + healthWord[health]}
    </T>
  );
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testID: string;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close"
          testID={testID + "-backdrop"}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.bg, opacity: 0.8 }}
        />
        <View
          testID={testID}
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: 20,
            paddingBottom: insets.bottom + 20,
            gap: 16,
          }}
        >
          <T variant="title">{title}</T>
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " h ago";
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : days + " days ago";
}
