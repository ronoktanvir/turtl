import { useEffect, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { useTheme } from "../../theme";
import { T } from ".";
import { nativeDriver, springs, useReducedMotion } from "./motion";

/**
 * An on/off switch. The label and the switch are one target, at least 44 pt each way, so the switch itself
 * can stay small. The thumb slides in 140 ms, or simply appears in place when Reduce Motion is on.
 */
export function Toggle({ value, onChange, label, accessibilityLabel, disabled, testID }: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  testID: string;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const at = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { at.setValue(value ? 1 : 0); return; }
    const slide = Animated.spring(at, { toValue: value ? 1 : 0, ...springs.toggle, useNativeDriver: nativeDriver });
    slide.start();
    return () => slide.stop();
  }, [value, reduced, at]);
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel ?? label}
      aria-checked={value}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      testID={testID}
      // A switch answers to the space bar; React Native Web's Pressable only gives that to buttons.
      {...({ onKeyDown: (event: { key: string; repeat?: boolean; preventDefault(): void }) => { if (event.key === " " && !event.repeat && !disabled) { event.preventDefault(); onChange(!value); } } } as object)}
      style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 4, opacity: disabled ? 0.65 : pressed ? 0.8 : 1 })}
    >
      <T variant="small" color="textMuted">{label}</T>
      <View style={{ width: 40, height: 24, borderRadius: 999, borderWidth: 1, paddingHorizontal: 2, justifyContent: "center", borderColor: value ? colors.brandDeep : colors.border, backgroundColor: value ? colors.brandDeep : colors.surfaceRaised }}>
        <Animated.View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: value ? colors.brand : colors.textMuted, transform: [{ translateX: at.interpolate({ inputRange: [0, 1], outputRange: [0, 16] }) }] }} />
      </View>
    </Pressable>
  );
}
