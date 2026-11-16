import { useRouter, type Href } from "expo-router";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentRef, type ReactNode, type Ref } from "react";
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  ScrollView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
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
import { Breathe, Pop, ZoomPressable, ease, nativeDriver, springs, time, usePressScale, useReducedMotion } from "./motion";
import { PulseArrival } from "./pulse";
import { ScreenEnter } from "./screenEnter";
import { sheetDrag, sheetLetsGo } from "./sheetDrag";
import { useSheetCover } from "./sheetCover";
import { faceFor, textOf, type Face } from "./typeface";
export { Icon, type IconName } from "./Icon";
export { Breathe, Pop, Reveal, ZoomPressable, usePressScale, useReducedMotion } from "./motion";
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

const fonts: Record<Face, string> = { title: "Righteous_400Regular", text: "Capriola_400Regular" };

// The face of the T this one sits inside, so a name set inline in a paragraph reads as part of that paragraph.
const ParentFace = createContext<Face | null>(null);

/**
 * All text. Text that is a full sentence or paragraph is set in Capriola; anything else (titles, names, labels,
 * status words, counts, dates) is set in Righteous. T decides from the words it draws (see typeface.ts); pass
 * `font` only where the words cannot tell, such as a field that is sometimes a label and sometimes a sentence.
 * A T inside another T takes the outer one's face, and `mono` stays monospace.
 */
export function T({
  variant = "body",
  font,
  color = "text",
  style,
  ...props
}: TextProps & { variant?: keyof typeof variants; font?: Face; color?: TokenName }) {
  const { colors } = useTheme();
  const parent = useContext(ParentFace);
  const face: Face = font ?? parent ?? faceFor(textOf(props.children));
  const family = font || variant !== "mono" ? { fontFamily: fonts[face], fontWeight: "400" as const } : { fontWeight: "400" as const };
  const fontSize = StyleSheet.flatten([variants[variant], style])?.fontSize ?? 16;
  // Righteous is a display face: below heading size its letters crowd, so they get a little air.
  const spacing = face === "title" && family.fontFamily && fontSize <= 16 ? { letterSpacing: 0.3 } : null;
  return (
    <ParentFace.Provider value={face}>
      <Text {...props} style={[variants[variant], spacing, { color: colors[color] }, style, family]} />
    </ParentFace.Provider>
  );
}

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }} testID={testID}>
      <ScreenEnter>{children}</ScreenEnter>
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
          style={{ width: 44, height: 44, marginLeft: -4, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="ArrowLeft" color="textMuted" />
        </Pressable>
      )}
      {scrollTitle ? (
        <ScrollingTitle title={title} testID={testID} />
      ) : (
        <T variant="heading" font="title" style={{ flex: 1 }} numberOfLines={2} testID={testID} accessibilityRole="header">
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
  useEffect(() => setX(0), [title]); // a new title starts at its beginning
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
        <T variant="heading" font="title" style={nowrap} testID={testID} accessibilityRole="header">
          {title}
        </T>
      </ScrollView>
      {overflow && x > 1 && <EdgeFade edge="left" />}
      {overflow && x < content - box - 1 && <EdgeFade edge="right" />}
    </View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// A button answers the instant it is touched. A phone's Pressable already does; the web's waits 50 ms before it
// calls a press a press unless told not to, under a prop of its own.
const instantPress = (Platform.OS === "web" ? { delayPressIn: 0 } : { unstable_pressDelay: 0 }) as { unstable_pressDelay?: number };

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
  testID,
  style,
  icon,
  ref,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "outline" | "plain" | "danger";
  disabled?: boolean;
  testID: string | undefined;
  style?: StyleProp<ViewStyle>;
  icon?: IconName;
  /** For moving focus to the button, as after a move between pages. */
  ref?: Ref<ComponentRef<typeof View>>;
}) {
  const { colors } = useTheme();
  const look: Record<typeof kind, { bg: string; border: string; text: TokenName }> = {
    primary: { bg: colors.brand, border: colors.brand, text: "onBrand" },
    outline: { bg: "transparent", border: colors.brandDeep, text: "text" },
    plain: { bg: colors.surfaceRaised, border: colors.border, text: "text" },
    danger: { bg: "transparent", border: colors.statusAffected, text: "statusAffected" },
  };
  const press = usePressScale(0.97);
  return (
    <AnimatedPressable
      ref={ref}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      {...instantPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      style={[
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
          opacity: disabled ? 0.65 : press.pressed.interpolate({ inputRange: [0, 1], outputRange: [1, 0.84] }),
          transform: [{ scale: press.scale }],
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={18} color={disabled ? "textMuted" : look[kind].text} />}
      <T variant="strong" font="title" color={disabled ? "textMuted" : look[kind].text} style={{ textAlign: "center" }}>
        {label}
      </T>
    </AnimatedPressable>
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
      <T variant="small" font="title" color={tone}>
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

export function Turtle({ health, size = 40, outlined, label, alive }: { health: Health; size?: number; outlined?: boolean; label?: string; /** Breathes slowly: for a large turtle with the screen to itself. */ alive?: boolean }) {
  const { colors } = useTheme();
  const picture = (
    <Image
      source={turtles[health]}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel={label ?? "turtl: " + healthWord[health]}
    />
  );
  const image = alive ? <Breathe>{picture}</Breathe> : picture;
  if (!outlined) return <Pop on={health}>{image}</Pop>;
  return (
    <Pop on={health}><View style={{ borderWidth: 2, borderColor: colors[healthToken[health]], borderRadius: size, padding: 6 }}>
      {image}
    </View></Pop>
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

/** The health word, true for the project: a practice app has no users, so it is broken, not "Users affected". */
export function healthWordFor(health: Health, practice = false): string {
  return practice && health === "affected" ? "Practice app broken" : healthWord[health];
}

export function HealthWord({ health, testID, practice = false }: { health: Health; testID?: string; practice?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }} testID={testID}>
      <Icon name={health === "affected" || health === "needs_you" ? "TriangleAlert" : health === "working" ? "Sparkles" : "ShieldCheck"} size={15} color={healthToken[health]} />
      <T variant="small" color={healthToken[health]}>{healthWordFor(health, practice)}</T>
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
  const reduced = useReducedMotion();
  const screen = useWindowDimensions().height;
  const [mounted, setMounted] = useState(visible);
  const [height, setHeight] = useState(0);
  const open = useRef(new Animated.Value(0)).current; // 0 closed, 1 open
  const drag = useRef(new Animated.Value(0)).current; // how far a finger has pulled the sheet down
  const now = useRef({ visible, onClose, height });
  now.current = { visible, onClose, height };
  const measured = height > 0;

  // Rises in on the curve a sheet rises on; leaves in about half the time. With Reduce Motion it only fades.
  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.setValue(0);
      if (!measured && !reduced) return; // it starts once its height is known, so it travels exactly its own height
      const rise = Animated.timing(open, { toValue: 1, duration: reduced ? time.quick : time.sheetIn, easing: ease.sheet, useNativeDriver: nativeDriver });
      rise.start();
      return () => rise.stop();
    }
    const leave = Animated.timing(open, { toValue: 0, duration: reduced ? time.quick : time.sheetOut, easing: ease.away, useNativeDriver: nativeDriver });
    leave.start(({ finished }) => { if (finished) setMounted(false); });
    return () => leave.stop();
  }, [visible, reduced, measured, open, drag]);

  // Pulling the handle or the title down drags the sheet; far or fast enough and it closes, otherwise it settles back.
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => drag.setValue(sheetDrag(g.dy)),
    onPanResponderRelease: (_, g) => {
      const settle = () => Animated.spring(drag, { toValue: 0, ...springs.settle, useNativeDriver: nativeDriver }).start();
      if (!sheetLetsGo(g.dy, g.vy, now.current.height)) return settle();
      Animated.timing(drag, { toValue: now.current.height || 600, duration: time.sheetOut, easing: ease.away, useNativeDriver: nativeDriver }).start(() => {
        now.current.onClose();
        // A sheet that may not close just now (it is saving) comes back up.
        setTimeout(() => { if (now.current.visible) settle(); }, 80);
      });
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, ...springs.settle, useNativeDriver: nativeDriver }).start(),
  })).current;

  const travel = reduced ? 0 : height || screen;
  const pulled = drag.interpolate({ inputRange: [0, Math.max(1, height)], outputRange: [1, 0], extrapolate: "clamp" });
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(open, pulled).interpolate({ inputRange: [0, 1], outputRange: [0, 0.8] }) }]}>
          <Pressable onPress={onClose} accessibilityLabel="Close" testID={testID + "-backdrop"} style={{ flex: 1, backgroundColor: colors.bg }} />
        </Animated.View>
        <Animated.View
          testID={testID}
          onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
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
            opacity: reduced ? open : 1,
            transform: [{ translateY: Animated.add(open.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] }), drag) }],
          }}
        >
          <View {...pan.panHandlers} style={{ gap: 16, marginTop: -8, paddingTop: 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center" }} />
            <T variant="title" font="title" selectable={false}>{title}</T>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 20 }}>{children}</ScrollView>
          {footer}
        </Animated.View>
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
