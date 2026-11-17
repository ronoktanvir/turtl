import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Animated, View, type StyleProp, type TextStyle } from "react-native";
import { T } from ".";
import { ease, nativeDriver, time, useReducedMotion } from "./motion";
import { rollOffsets, rollWay } from "./roll";

type Words = ComponentProps<typeof T>;

/**
 * A number a person watches: open bugs, feature requests. It is simply there when its screen first draws, and it
 * never counts up from nothing. When it changes it rolls like a counter's wheel: up for more, down for fewer. A
 * change made while its screen was out of view (a fix approved one screen deeper) rolls once the person is back and
 * the screen has settled, so they see what their action did. With Reduce Motion on the number is replaced in place.
 */
export function Count({ value, variant = "body", color, style, testID }: { value: number; variant?: Words["variant"]; color?: Words["color"]; style?: StyleProp<TextStyle>; testID?: string }) {
  const reduced = useReducedMotion();
  const focused = useIsFocused();
  const [shown, setShown] = useState(value);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [line, setLine] = useState(24);
  const progress = useRef(new Animated.Value(1)).current;
  const inView = useRef(focused);

  useEffect(() => {
    const back = focused && !inView.current;
    inView.current = focused;
    if (!focused || value === shown) return;
    if (reduced) {
      setLeaving(null);
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      setLeaving(shown);
      setShown(value);
    }, back ? time.screen : 0);
    return () => clearTimeout(timer);
  }, [focused, value, shown, reduced]);

  useEffect(() => {
    if (leaving === null) return;
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: time.roll, easing: ease.out, useNativeDriver: nativeDriver });
    animation.start(({ finished }) => {
      if (finished) setLeaving(null);
    });
    return () => animation.stop();
  }, [leaving, shown, progress]);

  const offsets = rollOffsets(leaving === null ? "none" : rollWay(leaving, shown), line);
  return (
    <View testID={testID} accessible accessibilityRole="text" accessibilityLabel={String(value)} onLayout={(event) => setLine(event.nativeEvent.layout.height || 24)}>
      <Animated.View style={leaving === null ? null : { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offsets.enter, 0] }) }] }}>
        <T variant={variant} color={color} style={style}>{shown}</T>
      </Animated.View>
      {leaving !== null && (
        <Animated.View
          pointerEvents="none"
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", left: 0, top: 0, opacity: progress.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: "clamp" }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, offsets.leave] }) }] }}
        >
          <T variant={variant} color={color} style={style}>{leaving}</T>
        </Animated.View>
      )}
    </View>
  );
}
