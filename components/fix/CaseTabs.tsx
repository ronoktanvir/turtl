import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { useTheme, type TokenName } from "../../theme";
import { Icon, T, useReducedMotion } from "../ui";
import { ease, nativeDriver, time } from "../ui/motion";
import { tabPositions } from "./tabLayout";

export const caseTabs = ["Overview", "Logs", "Code"] as const;
export type CaseTab = (typeof caseTabs)[number];

const icons = { Overview: "Layers", Logs: "Terminal", Code: "Code2" } as const;
// Each tab's own colour when selected, for its label, its icon and its underline. Unselected tabs stay muted.
const tints: Record<CaseTab, TokenName> = { Overview: "tabOverview", Logs: "tabLogs", Code: "tabCode" };
const PADDING = 16;
const GAP = 18;
const HEIGHT = 48;

/**
 * Overview, Logs and Code. The selected tab stands apart and the others gather on the side they come from (see
 * tabLayout.ts); choosing another slides them to their new places.
 */
export function CaseTabs({ tab, onSelect, id }: { tab: CaseTab; onSelect: (tab: CaseTab) => void; id: (name: string) => string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [widths, setWidths] = useState<number[]>(caseTabs.map(() => 0));
  const xs = tabPositions(widths, caseTabs.indexOf(tab), width, PADDING, GAP);
  const offsets = useRef(caseTabs.map(() => new Animated.Value(0))).current;
  const placed = useRef(false);
  const key = xs?.join(",") ?? "";
  useEffect(() => {
    if (!xs) return;
    if (!placed.current || reduced) {
      xs.forEach((x, i) => offsets[i].setValue(x));
      placed.current = true;
      return;
    }
    const slide = Animated.parallel(xs.map((x, i) => Animated.timing(offsets[i], { toValue: x, duration: time.tab, easing: ease.move, useNativeDriver: nativeDriver })));
    slide.start();
    return () => slide.stop();
  }, [key, reduced, offsets]); // xs is a new array on every render; its positions, in `key`, are what matter

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ height: HEIGHT, borderBottomWidth: 1, borderBottomColor: colors.border }}
      testID={id("case-tabs")}
    >
      {caseTabs.map((name, i) => {
        const on = name === tab;
        return (
          <Animated.View
            key={name}
            onLayout={(event) => {
              const measured = event.nativeEvent.layout.width;
              setWidths((now) => (now[i] === measured ? now : now.map((w, j) => (j === i ? measured : w))));
            }}
            style={{ position: "absolute", top: 0, bottom: 0, left: 0, opacity: xs ? 1 : 0, transform: [{ translateX: offsets[i] }] }}
          >
            <Pressable
              onPress={() => onSelect(name)}
              accessibilityRole="tab"
              aria-selected={on}
              accessibilityState={{ selected: on }}
              accessibilityLabel={name}
              testID={id("tab-" + name.toLowerCase())}
              style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 2 }}
            >
              <Icon name={icons[name]} size={17} color={on ? tints[name] : "textMuted"} strokeWidth={on ? 2 : 1.7} />
              <T variant={on ? "strong" : "body"} color={on ? tints[name] : "textMuted"} selectable={false}>
                {name}
              </T>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, borderRadius: 1, backgroundColor: on ? colors[tints[name]] : "transparent" }} />
            </Pressable>
          </Animated.View>
        );
      })}
    </View>
  );
}
