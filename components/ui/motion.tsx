import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../../theme";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

export function Reveal({ children, delay = 0, style, replayKey, progress }: { children: ReactNode; delay?: number; style?: StyleProp<ViewStyle>; replayKey?: string; progress?: boolean }) {
  const reduced = useReducedMotion();
  const { colors } = useTheme();
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) { value.setValue(1); return; }
    value.setValue(0);
    const animation = Animated.timing(value, { toValue: 1, duration: 240, delay: Math.min(delay, 80), easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [reduced, delay, value, replayKey]);
  return <Animated.View style={[style, { opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }, { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.965, 1] }) }] }]}>
    {children}
    {progress && <Animated.View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, backgroundColor: colors.brandDeep, transform: [{ scaleX: value }], opacity: value.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.5, 0.5, 0] }) }} />}
  </Animated.View>;
}

export function ZoomPressable({ onPress, containerStyle, ...props }: PressableProps & { containerStyle?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const opening = useRef(false);
  useEffect(() => () => scale.stopAnimation(), [scale]);
  return <Animated.View style={[containerStyle, { transform: [{ scale }] }]}><Pressable {...props} onPress={(event) => {
    if (opening.current || !onPress) return;
    if (reduced) { onPress(event); return; }
    opening.current = true;
    Animated.timing(scale, { toValue: 1.025, duration: 90, useNativeDriver: true }).start(({ finished }) => {
      if (finished) onPress(event);
      Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start(() => { opening.current = false; });
    });
  }} /></Animated.View>;
}
