import { useRouter, type Href } from "expo-router";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Image,
  Modal,
  ScrollView,
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
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { devToolsAllowed } from "../../data/source";
import type { Health } from "../../data/types";
import { healthToken, healthWord, useTheme, type TokenName } from "../../theme";
import { Icon, type IconName } from "./Icon";
import { Reveal, ZoomPressable } from "./motion";
import { PulseArrival } from "./pulse";
import { useSheetCover } from "./sheetCover";
export { Icon, type IconName } from "./Icon";
export { Reveal, ZoomPressable, useReducedMotion } from "./motion";
export { caseTitle } from "./caseTitle";
export { BrandIcon } from "./BrandIcon";

export const devToolsOn = !!process.env.EXPO_PUBLIC_CONVEX_URL && devToolsAllowed;

const turtles: Record<Health, number> = {
  affected: require("../../assets/turtle/affected-laptop.png"),
  needs_you: require("../../assets/turtle/needs_you.png"),
  working: require("../../assets/turtle/working-laptop.png"),
  clear: require("../../assets/turtle/clear.png"),
};

const logos: Record<Health, number> = {
  affected: require("../../assets/brand/logo-affected.png"),
  needs_you: require("../../assets/brand/logo-needs_you.png"),
  working: require("../../assets/brand/logo-working.png"),
  clear: require("../../assets/brand/logo-clear.png"),
};

const variants = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700", letterSpacing: -0.3 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700", letterSpacing: -0.3 },
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

const fonts = { title: "Righteous_400Regular", text: "Capriola_400Regular" };

export function T({
  variant = "body",
  font = variant === "display" || variant === "title" || variant === "heading" ? "title" : "text",
  color = "text",
  style,
  ...props
}: TextProps & { variant?: keyof typeof variants; font?: keyof typeof fonts; color?: TokenName }) {
  const { colors } = useTheme();
  return <Text {...props} style={[variants[variant], { color: colors[color] }, style, { fontFamily: fonts[font], fontWeight: "400" }]} />;
}

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }} testID={testID}>
      <Reveal style={{ flex: 1 }} progress>{children}</Reveal>
      <PulseArrival />
    </View>
  );
}

export function Header({
  title,
  fallback,
  right,
  testID,
  scrollTitle,
}: {
  title: string;
  fallback?: Href;
  right?: ReactNode;
  testID?: string;
  /** Keep the title on one line, scrolling sideways when it is too long to fit (an opened issue's name). */
  scrollTitle?: boolean;
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
          <Icon name="ArrowLeft" color="textMuted" />
        </Pressable>
      )}
      {scrollTitle ? (
        <ScrollingTitle title={title} testID={testID} />
      ) : (
        <T variant="heading" style={{ flex: 1 }} numberOfLines={2} testID={testID} accessibilityRole="header">
          {title}
        </T>
      )}
      {right}
    </View>
  );
}

/** A fade into the background at one edge of a scrolling area: the hint that there is more past that edge. */
export function EdgeFade({ edge, size = 28 }: { edge: "left" | "right" | "top" | "bottom"; size?: number }) {
  const { colors } = useTheme();
  const gradient = "edge-fade-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const across = edge === "left" || edge === "right";
  const solidAtEnd = edge === "right" || edge === "bottom";
  return (
    <View pointerEvents="none" style={{ position: "absolute", [edge]: 0, ...(across ? { top: 0, bottom: 0, width: size } : { left: 0, right: 0, height: size }) }}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={gradient} x1="0" y1="0" x2={across ? "1" : "0"} y2={across ? "0" : "1"}>
            <Stop offset="0" stopColor={colors.bg} stopOpacity={solidAtEnd ? 0 : 1} />
            <Stop offset="1" stopColor={colors.bg} stopOpacity={solidAtEnd ? 1 : 0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradient})`} />
      </Svg>
    </View>
  );
}

const nowrap = Platform.OS === "web" ? ({ whiteSpace: "nowrap" } as unknown as TextStyle) : null;

/**
 * A title kept to one line. When it is longer than the line, it scrolls sideways under a finger, a trackpad or a
 * mouse wheel, with a fade at whichever edge has more to show. Screen readers read it whole.
 */
function ScrollingTitle({ title, testID }: { title: string; testID?: string }) {
  const [box, setBox] = useState(0);
  const [content, setContent] = useState(0);
  const [x, setX] = useState(0);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const overflow = content > box + 1;
  // A mouse wheel has no sideways axis, so over a title that does not fit, its up and down scroll the title.
  useEffect(() => {
    if (Platform.OS !== "web" || !node || !overflow) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const next = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + event.deltaY));
      if (next === node.scrollLeft) return;
      event.preventDefault();
      node.scrollLeft = next;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [node, overflow]);
  return (
    <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
      <ScrollView
        key={title}
        ref={(view) => setNode((view?.getScrollableNode?.() as HTMLElement | undefined) ?? null)}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onLayout={(event) => setBox(event.nativeEvent.layout.width)}
        onContentSizeChange={(width) => setContent(width)}
        onScroll={(event) => setX(event.nativeEvent.contentOffset.x)}
        contentContainerStyle={{ alignItems: "center" }}
        testID={testID ? testID + "-scroller" : undefined}
      >
        <T variant="heading" style={nowrap} testID={testID} accessibilityRole="header">
          {title}
        </T>
      </ScrollView>
      {overflow && x > 1 && <EdgeFade edge="left" />}
      {overflow && x < content - box - 1 && <EdgeFade edge="right" />}
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
  icon,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "outline" | "plain" | "danger";
  disabled?: boolean;
  testID: string | undefined;
  style?: StyleProp<ViewStyle>;
  icon?: IconName;
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
          borderWidth: 1,
          alignItems: "center",
          flexDirection: "row",
          gap: 8,
          justifyContent: "center",
          backgroundColor: disabled ? colors.surfaceRaised : look[kind].bg,
          borderColor: disabled ? colors.border : look[kind].border,
          opacity: disabled ? 0.65 : pressed ? 0.8 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={18} color={disabled ? "textMuted" : look[kind].text} />}
      <T variant="strong" color={disabled ? "textMuted" : look[kind].text} style={{ textAlign: "center" }}>
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
    borderRadius: 20,
    padding: 20,
  };
  if (!onPress) {
    return (
      <View style={[base, style]} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <ZoomPressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [base, pressed && { backgroundColor: colors.surfaceRaised }, style]}
    >
      {children}
    </ZoomPressable>
  );
}

export function Turtle({ health, size = 40, outlined, label }: { health: Health; size?: number; outlined?: boolean; label?: string }) {
  const { colors } = useTheme();
  const image = (
    <Image
      source={turtles[health]}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel={label ?? "turtl: " + healthWord[health]}
    />
  );
  if (!outlined) return <Reveal replayKey={health}>{image}</Reveal>;
  return (
    <Reveal replayKey={health}><View style={{ borderWidth: 2, borderColor: colors[healthToken[health]], borderRadius: size, padding: 6 }}>
      {image}
    </View></Reveal>
  );
}

export function Logo({ health, width = 200 }: { health: Health; width?: number }) {
  return (
    <Image
      source={logos[health]}
      style={{ width, height: Math.round((width * 265) / 840) }}
      resizeMode="contain"
      accessibilityLabel="turtl"
    />
  );
}

export function HealthWord({ health, testID }: { health: Health; testID?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} testID={testID}>
      <Icon name={health === "affected" || health === "needs_you" ? "TriangleAlert" : health === "working" ? "Sparkles" : "ShieldCheck"} size={15} color={healthToken[health]} />
      <T variant="small" color={healthToken[health]}>{healthWord[health]}</T>
    </View>
  );
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  testID,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testID: string;
  footer?: ReactNode; // stays below the scrolling content, so a confirm button is never scrolled away
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const cover = useSheetCover();
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
            maxHeight: "90%",
          }}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center" }} />
          <T variant="title">{title}</T>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 20 }}>{children}</ScrollView>
          {footer}
        </View>
        {cover}
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
