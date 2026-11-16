import { usePathname } from "expo-router";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Animated, Platform, View } from "react-native";
import { arrival, arrivalOffset } from "./arrival";
import { ease, time, useReducedMotion } from "./motion";
import { pulseWaiting } from "./pulse";

// On a phone the system slides one screen over another. A browser has no such thing: a new screen would simply
// replace the last. So on the web each screen arrives with a short slide and fade from the side it was reached
// from (see arrival.ts), both when it first opens and when the person comes back to it. A screen opened through
// the green drop surfaces out of the green instead, and does not slide as well.

let lastShown: string | null = null;

function WebEnter({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const mine = useRef(pathname).current; // the address this screen was opened for
  const moves = (way: ReturnType<typeof arrival>) => !reduced && way !== "first" && !pulseWaiting();
  // Decided before the first frame, so a screen that slides in is never drawn in place first.
  const opening = useRef(arrival(lastShown, mine)).current;
  const shown = useRef(new Animated.Value(moves(opening) ? 0 : 1)).current;
  const x = useRef(new Animated.Value(moves(opening) ? arrivalOffset(opening) : 0)).current;
  useLayoutEffect(() => {
    if (pathname !== mine) return; // another screen is in front
    const way = arrival(lastShown, mine);
    lastShown = mine;
    if (!moves(way)) {
      shown.setValue(1);
      x.setValue(0);
      return;
    }
    shown.setValue(0);
    x.setValue(arrivalOffset(way));
    const animation = Animated.parallel([
      Animated.timing(shown, { toValue: 1, duration: time.screen * 0.7, easing: ease.out, useNativeDriver: false }),
      Animated.timing(x, { toValue: 0, duration: time.screen, easing: ease.out, useNativeDriver: false }),
    ]);
    animation.start();
    return () => {
      animation.stop();
      shown.setValue(1);
      x.setValue(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- replays only when the address changes
  }, [pathname]);
  return <Animated.View style={{ flex: 1, opacity: shown, transform: [{ translateX: x }] }}>{children}</Animated.View>;
}

function Plain({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}

/** Wraps a screen's content so it arrives the way its platform expects. */
export const ScreenEnter = Platform.OS === "web" ? WebEnter : Plain;
