import { useEffect, useRef, useState, type ReactNode } from "react";
import { STAGGER_CAP } from "./arrival";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, type GestureResponderEvent, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

// turtl's motion, in one place. The rules every animation here follows:
// - What a person starts (a press, a new screen, a sheet) answers at once and eases out; nothing they do waits on
//   an animation, and anything in flight can be interrupted by the next press.
// - Things move a short way and never grow from nothing: an entrance travels a few points and fades, a press gives
//   by a few hundredths.
// - Leaving is quicker than arriving.
// - Only position, size and opacity move, so nothing lays out again mid-flight.
// - With Reduce Motion on, movement is dropped and a short fade, or nothing, is left.

/** Animated's native driver where there is one. The web has none, and warns if asked. */
export const nativeDriver = Platform.OS !== "web";

/** The curves. `out` for anything arriving or answering a press, `inOut` for something already on screen moving to a new place, `move` for an indicator sliding between two resting places, `sheet` for a panel rising from an edge, `away` for leaving. */
export const ease = {
  out: Easing.bezier(0.23, 1, 0.32, 1),
  inOut: Easing.bezier(0.77, 0, 0.175, 1),
  move: Easing.bezier(0.3, 0, 0, 1),
  sheet: Easing.bezier(0.32, 0.72, 0, 1),
  away: Easing.bezier(0.4, 0, 1, 1),
};

/** How long things take, in milliseconds. */
export const time = { press: 120, quick: 160, enter: 300, tab: 250, screen: 300, sheetIn: 460, sheetOut: 240 };

/** Springs with no bounce to speak of: `press` for a control letting go, `settle` for something dragged coming to rest, `toggle` for a switch's thumb. */
export const springs = {
  press: { stiffness: 420, damping: 28, mass: 1 },
  settle: { stiffness: 440, damping: 34, mass: 1 },
  toggle: { stiffness: 1400, damping: 67, mass: 1 },
};

export { STAGGER_CAP, stagger } from "./arrival";

// --- Reduce Motion ---

let known: boolean | null = null;
let primed = false;
const listeners = new Set<(reduced: boolean) => void>();

function learn(reduced: boolean) {
  known = reduced;
  listeners.forEach((listener) => listener(reduced));
}

function prime() {
  if (primed) return;
  primed = true;
  try {
    // The web can answer at once; a phone answers a moment later.
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.matchMedia === "function") known = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void AccessibilityInfo.isReduceMotionEnabled().then(learn).catch(() => {});
    AccessibilityInfo.addEventListener("reduceMotionChanged", learn);
  } catch {
    // No accessibility service to ask: stay still.
  }
}

/**
 * Whether the person has asked for less motion. The answer is asked for once and shared, so a screen that mounts
 * later knows it on its first frame; until it is known, the answer is yes.
 */
export function useReducedMotion() {
  prime();
  const [reduced, setReduced] = useState(known ?? true);
  useEffect(() => {
    listeners.add(setReduced);
    if (known !== null) setReduced(known);
    return () => {
      listeners.delete(setReduced);
    };
  }, []);
  return reduced;
}

// --- Arriving ---

/**
 * Brings its children in: a short rise and a fade, once when they first appear and again whenever `replayKey`
 * changes. Give the items of a list a growing `delay` and they arrive one after another, capped so the last is
 * never kept waiting. If Reduce Motion is on, or not yet known, when it first draws, the children are simply there.
 */
export function Reveal({ children, delay = 0, style, replayKey, rise = 8 }: { children: ReactNode; delay?: number; style?: StyleProp<ViewStyle>; replayKey?: string; rise?: number }) {
  const reduced = useReducedMotion();
  const still = useRef(reduced); // decided on the first frame, so nothing already drawn is hidden and brought back
  const value = useRef(new Animated.Value(still.current ? 1 : 0)).current;
  const played = useRef<string | undefined | null>(null);
  useEffect(() => {
    const first = played.current === null;
    if (!first && played.current === replayKey) return;
    played.current = replayKey;
    if (reduced || (first && still.current)) {
      value.setValue(1);
      return;
    }
    value.setValue(0);
    const animation = Animated.timing(value, { toValue: 1, duration: time.enter, delay: first ? Math.min(delay, STAGGER_CAP) : 0, easing: ease.out, useNativeDriver: nativeDriver });
    animation.start();
    // Cut short (a newer entrance, or the effect run twice in development), the children are left shown, never half in.
    return () => {
      animation.stop();
      value.setValue(1);
    };
  }, [reduced, delay, value, replayKey]);
  return <Animated.View style={[style, { opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] }) }] }]}>{children}</Animated.View>;
}

/**
 * Marks a change of state: its children give a small spring when `on` changes, and do nothing when they first
 * appear. For a turtle whose mood changed, or a count that moved.
 */
export function Pop({ children, on, style }: { children: ReactNode; on: string | number; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(1)).current;
  const last = useRef(on);
  useEffect(() => {
    if (last.current === on) return;
    last.current = on;
    if (reduced) return;
    value.setValue(0);
    const animation = Animated.spring(value, { toValue: 1, stiffness: 300, damping: 20, mass: 1, useNativeDriver: nativeDriver });
    animation.start();
    return () => animation.stop();
  }, [on, reduced, value]);
  return <Animated.View style={[style, { opacity: value.interpolate({ inputRange: [0, 0.4], outputRange: [0.4, 1], extrapolate: "clamp" }), transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) }] }]}>{children}</Animated.View>;
}

/**
 * A slow breath for a large turtle that has the screen to itself: it rises a point or two and swells by a
 * fiftieth, about once every four seconds. Still with Reduce Motion on.
 */
export function Breathe({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(0);
      return;
    }
    const half = (toValue: number) => Animated.timing(value, { toValue, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: nativeDriver });
    const loop = Animated.loop(Animated.sequence([half(1), half(0)]));
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  return <Animated.View style={{ transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) }, { scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) }] }}>{children}</Animated.View>;
}

/**
 * Three dots that rise and brighten one after another, for "turtl is thinking". One pass takes 1.2 seconds and each
 * dot starts 160 ms after the one before. With Reduce Motion on they are three still dots.
 */
export function TypingDots({ color, size = 6 }: { color: string; size?: number }) {
  const reduced = useReducedMotion();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduced) {
      dots.forEach((dot) => dot.setValue(0.5));
      return;
    }
    const beat = (dot: Animated.Value, index: number) => Animated.loop(Animated.sequence([
      Animated.delay(index * 160),
      Animated.timing(dot, { toValue: 1, duration: 300, easing: ease.out, useNativeDriver: nativeDriver }),
      Animated.timing(dot, { toValue: 0, duration: 380, easing: Easing.inOut(Easing.sin), useNativeDriver: nativeDriver }),
      Animated.delay(520 - index * 160),
    ]));
    const loops = dots.map(beat);
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [reduced, dots]);
  return (
    <Animated.View aria-hidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", alignItems: "center", gap: size * 0.7, height: size * 2 }}>
      {dots.map((dot, index) => (
        <Animated.View key={index} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }), transform: [{ translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.5] }) }] }} />
      ))}
    </Animated.View>
  );
}

// --- Pressing ---

/**
 * What a control does under a finger or a mouse: it gives a little the moment it is pressed and springs back when
 * let go. Returns the value to scale by (and to dim by, if wanted) and the two handlers to pass to a Pressable.
 * The press itself is never delayed.
 */
export function usePressScale(to = 0.97) {
  const reduced = useReducedMotion();
  const pressed = useRef(new Animated.Value(0)).current;
  useEffect(() => () => pressed.stopAnimation(), [pressed]);
  const scale = useRef(pressed.interpolate({ inputRange: [0, 1], outputRange: [1, to] })).current;
  return {
    pressed,
    scale: reduced ? 1 : scale,
    onPressIn: () => Animated.timing(pressed, { toValue: 1, duration: time.press, easing: ease.out, useNativeDriver: nativeDriver }).start(),
    onPressOut: () => Animated.spring(pressed, { toValue: 0, ...springs.press, useNativeDriver: nativeDriver }).start(),
  };
}

/** A Pressable for cards and tiles: the whole surface gives a little while it is held. `containerStyle` goes on the part that scales. */
export function ZoomPressable({ containerStyle, onPressIn, onPressOut, ...props }: PressableProps & { containerStyle?: StyleProp<ViewStyle> }) {
  const press = usePressScale(0.98);
  return (
    <Animated.View style={[containerStyle, { transform: [{ scale: press.scale }] }]}>
      <Pressable
        {...props}
        onPressIn={(event: GestureResponderEvent) => { press.onPressIn(); onPressIn?.(event); }}
        onPressOut={(event: GestureResponderEvent) => { press.onPressOut(); onPressOut?.(event); }}
      />
    </Animated.View>
  );
}
