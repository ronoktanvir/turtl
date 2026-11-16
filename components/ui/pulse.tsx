import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Animated, Easing, PanResponder, Platform, StyleSheet, View, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import { useTheme } from "../../theme";
import { DEAD_ZONE, isVerticalPull, restingWheel, shouldComplete, swipeProgress, wheelPixels, wheelProgress, wheelStep, WHEEL_SETTLE } from "./swipe";

// turtl's one way of moving from a summary to what you do about it: a drop of green that spreads from where you
// pulled until it fills the screen, and the next screen surfacing out of it. The issues list uses it to open the
// first issue; an issue uses it to move to its fixes and back.

/** Animated drivers: the native one where there is one. The web has none, and warns if asked. */
export const nativeDriver = Platform.OS !== "web";

/** The drop's value when its deep green covers every corner. 0 is no drop, 1 a full pull, between them the pull. */
export const DROP_FULL = 1.1;

/** The drop's radius, as a share of the distance to the farthest corner, at each value: it grows a little faster at first. */
const reachAt = { inputRange: [0, 0.5, 1, DROP_FULL], outputRange: [0.002, 0.44, 0.93, 1.03] };

/**
 * The drop itself: a deep green disc (brandDeep) with a pale rim (brand) and a faint halo running just ahead of it,
 * centred on (x, y) in its parent and drawn over it, sized to reach `reach` (the distance to the parent's farthest
 * corner) when full. The rim and halo scale with the disc, so they are hairlines while the drop is small. It never
 * takes a touch.
 */
export function Droplet({ value, x, y, reach }: { value: Animated.Value; x: number; y: number; reach: number }) {
  const { colors } = useTheme();
  if (!(reach > 0)) return null;
  const disc = { position: "absolute" as const, left: x - reach, top: y - reach, width: reach * 2, height: reach * 2, borderRadius: reach };
  const scale = value.interpolate(reachAt);
  const shown = value.interpolate({ inputRange: [0, 0.01], outputRange: [0, 1], extrapolate: "clamp" });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} aria-hidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[disc, { backgroundColor: colors.brand, opacity: value.interpolate({ inputRange: [0, 0.03, 0.9, DROP_FULL], outputRange: [0, 0.14, 0.14, 0], extrapolate: "clamp" }), transform: [{ scale: Animated.multiply(scale, 1.1) }] }]} />
      <Animated.View style={[disc, { borderWidth: Math.max(6, reach * 0.022), borderColor: colors.brand, opacity: shown, transform: [{ scale }] }]} />
      <Animated.View style={[disc, { backgroundColor: colors.brandDeep, opacity: shown, transform: [{ scale: Animated.multiply(scale, 0.986) }] }]} />
    </View>
  );
}

/** How long the drop takes to finish from a given value, so a long pull is not made to wait and a tap still reads as a spread. */
export function fillDuration(from: number) {
  return Math.round(160 + 300 * Math.max(0, 1 - from));
}

/** Plays the drop from wherever it is to full, then calls `done` once it covers everything. */
export function fillDrop(value: Animated.Value, from: number, done: () => void) {
  Animated.timing(value, { toValue: DROP_FULL, duration: fillDuration(from), easing: Easing.inOut(Easing.cubic), useNativeDriver: nativeDriver }).start(({ finished }) => {
    if (finished) done();
  });
}

/** Lets a pull that was not far enough fall back to nothing. */
export function dropBack(value: Animated.Value) {
  Animated.spring(value, { toValue: 0, speed: 18, bounciness: 0, useNativeDriver: nativeDriver }).start();
}

// --- Arriving out of the green ---

let handedOffAt = 0;

/** Called just before a screen opens behind a full drop: the screen that opens next starts covered in the same green. */
export function handOffPulse() {
  handedOffAt = Date.now();
}

function pulseWaiting() {
  return Date.now() - handedOffAt < 1500;
}

/**
 * The green a screen opened through the drop starts under, fading away so the screen surfaces out of it with no
 * blank frame between. Drawn by Screen, above everything and outside its own entrance animation.
 */
export function PulseArrival() {
  const { colors } = useTheme();
  const [covered, setCovered] = useState(pulseWaiting);
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!covered) return;
    handedOffAt = 0;
    const animation = Animated.timing(value, { toValue: 0, duration: 420, delay: 60, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver });
    animation.start(({ finished }) => { if (finished) setCovered(false); });
    return () => animation.stop();
  }, [covered, value]);
  if (!covered) return null;
  return <Animated.View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants" testID="pulse-arrival" style={[StyleSheet.absoluteFill, { backgroundColor: colors.brandDeep, opacity: value }]} />;
}

// --- Pulling with a finger or a mouse ---

type Pull = {
  /** Which way the finger moves to pull. */
  direction: "up" | "down";
  /** How far it moves for a full pull. */
  travel: number;
  /** Whether a pull may start now: at the page's edge, and with nothing else moving. */
  canStart: () => boolean;
  /** On the web, whether a mouse drag pulls too (the list's swipe zone) or only a finger does (a page, where a mouse drag selects text). */
  mouse: boolean;
  onStart?: () => void;
  onPull: (progress: number) => void;
  onRelease: (complete: boolean, progress: number) => void;
};

/**
 * Pan handlers for a vertical pull. They claim the gesture only once it is clearly vertical and in the pull's
 * direction, so taps still reach buttons and sideways swipes still reach the issue pager; and they claim it in the
 * capture phase, so a pull that starts on a button or carries on from scrolling a page to its end is still a pull.
 */
export function usePull(pull: Pull) {
  const latest = useRef(pull);
  latest.current = pull;
  const origin = useRef(0);
  return useMemo(() => {
    const toward = (g: PanResponderGestureState) => (latest.current.direction === "up" ? -g.dy : g.dy);
    const claims = (event: GestureResponderEvent, g: PanResponderGestureState) => {
      const now = latest.current;
      if (Platform.OS === "web" && !now.mouse && String((event.nativeEvent as { type?: string }).type ?? "").startsWith("mouse")) return false;
      return isVerticalPull(g.dx, g.dy, now.direction) && now.canStart();
    };
    const progress = (g: PanResponderGestureState) => swipeProgress(toward(g) - origin.current, latest.current.travel);
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: claims,
      onMoveShouldSetPanResponder: claims,
      onPanResponderGrant: (_, g) => {
        origin.current = Math.max(0, toward(g) - DEAD_ZONE); // from where it became a pull, not from where a scroll began
        latest.current.onStart?.();
        latest.current.onPull(progress(g));
      },
      onPanResponderMove: (_, g) => latest.current.onPull(progress(g)),
      onPanResponderRelease: (_, g) => {
        const p = progress(g);
        latest.current.onRelease(shouldComplete(p, latest.current.direction === "up" ? -g.vy : g.vy), p);
      },
      onPanResponderTerminate: (_, g) => latest.current.onRelease(false, progress(g)),
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    }).panHandlers;
  }, []);
}

// --- Pulling with a wheel or a trackpad (web) ---

type WheelPullOptions = {
  /** 1 when scrolling down (deltaY above 0, a trackpad swipe up) pulls, -1 when scrolling up does. */
  direction: () => 1 | -1;
  atEdge: () => boolean;
  /** While a move plays, wheel events are held so momentum does not scroll the page arriving under the green. */
  busy: () => boolean;
  onPull: (progress: number) => void;
  onRelease: (complete: boolean, progress: number) => void;
};

/**
 * Wheel and trackpad pulls on the web, by the rule in swipe.ts. Returns a ref for the view that listens. A pull
 * completes on its own once it reaches the full distance, and otherwise settles a moment after the scrolling stops.
 */
export function useWheelPull(options: WheelPullOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !node || typeof node.addEventListener !== "function") return;
    let state = restingWheel;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      timer = undefined;
      const progress = wheelProgress(state);
      state = { lastAt: state.lastAt, distance: 0 };
      if (progress > 0) latest.current.onRelease(shouldComplete(progress), progress);
    };
    const onWheel = (event: WheelEvent) => {
      const now = latest.current;
      if (now.busy()) {
        event.preventDefault();
        state = { lastAt: event.timeStamp, distance: 0 };
        return;
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return; // sideways belongs to the issue pager and the title
      const before = state.distance;
      state = wheelStep(state, event.timeStamp, wheelPixels(event.deltaY, event.deltaMode, node.clientHeight) * now.direction(), now.atEdge());
      if (before === 0 && state.distance === 0) return; // ordinary scrolling
      if (before > 0) event.preventDefault(); // scrolling back undoes the pull before it moves the page
      if (timer) clearTimeout(timer);
      timer = undefined;
      const progress = wheelProgress(state);
      if (progress >= 1) {
        state = { lastAt: event.timeStamp, distance: 0 };
        now.onRelease(true, 1);
        return;
      }
      now.onPull(progress);
      if (progress > 0) timer = setTimeout(settle, WHEEL_SETTLE);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      if (timer) clearTimeout(timer);
    };
  }, [node]);
  return useCallback((view: ComponentRef<typeof View> | null) => setNode(view as unknown as HTMLElement | null), []);
}
