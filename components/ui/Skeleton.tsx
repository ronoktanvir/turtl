import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { Card } from ".";
import { useTheme } from "../../theme";
import { ease, nativeDriver, time, useReducedMotion } from "./motion";
import { SKELETON_WAIT, lineWidths } from "./skeletonRules";

/**
 * Holds the place of a screen that is waiting for its data, in the shape of what is coming, so the screen does not
 * jump when it arrives. It keeps its room from the first frame but stays unseen for a moment, so data already on
 * its way never flashes one; then it fades in and its bones dim and brighten together, slowly. With Reduce Motion
 * on they hold still. A screen reader hears `label`.
 */
export function Skeleton({ children, label = "Loading", style, testID }: { children: ReactNode; label?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  const reduced = useReducedMotion();
  const [late, setLate] = useState(false);
  const shown = useRef(new Animated.Value(0)).current;
  const dim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), SKELETON_WAIT);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!late) return;
    const arrive = Animated.timing(shown, { toValue: 1, duration: time.quick, easing: ease.out, useNativeDriver: nativeDriver });
    arrive.start();
    if (reduced) {
      dim.setValue(0);
      return () => arrive.stop();
    }
    const half = (toValue: number) => Animated.timing(dim, { toValue, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: nativeDriver });
    const breathing = Animated.loop(Animated.sequence([half(1), half(0)]));
    breathing.start();
    return () => {
      arrive.stop();
      breathing.stop();
    };
  }, [late, reduced, shown, dim]);
  return (
    <Animated.View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={label} aria-busy style={[style, { opacity: Animated.multiply(shown, dim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] })) }]}>
      {children}
    </Animated.View>
  );
}

/** One placeholder shape: a bar for a line of text, a square for an icon, a circle for a turtle. */
export function Bone({ width, height = 12, radius = 999, style }: { width: DimensionValue; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: colors.border }, style]} />;
}

/** Bars standing in for a paragraph, each taking the room of one line of body text. */
function Lines({ lines }: { lines: number }) {
  return (
    <View>
      {lineWidths(lines).map((width, index) => (
        <View key={index} style={{ height: 24, justifyContent: "center" }}><Bone width={`${width}%`} /></View>
      ))}
    </View>
  );
}

/** A few lines of text on their way: for a section or a short screen with no shape of its own. */
export function SkeletonLines({ lines = 3, style, testID }: { lines?: number; style?: StyleProp<ViewStyle>; testID?: string }) {
  return <Skeleton style={style} testID={testID}><Lines lines={lines} /></Skeleton>;
}

/** Projects: three project cards. */
export function SkeletonProjects({ narrow = false }: { narrow?: boolean }) {
  return (
    <Skeleton style={{ gap: 12 }} testID="projects-loading">
      {[0, 1, 2].map((card) => (
        <Card key={card}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: narrow ? 8 : 12 }}>
            <Bone width={narrow ? 36 : 44} height={narrow ? 36 : 44} radius={10} />
            <View style={{ flex: 1, gap: 3 }}><View style={{ height: 28, justifyContent: "center" }}><Bone width="62%" height={16} /></View><View style={{ height: 23, justifyContent: "center" }}><Bone width="36%" /></View></View>
            <Bone width={narrow ? 30 : 38} height={narrow ? 30 : 38} />
          </View>
          <View style={{ marginTop: 16 }}><Lines lines={2} /></View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 20 }}>
            <View style={{ gap: 2 }}>
              <View style={{ height: 24, justifyContent: "center" }}><Bone width={64} /></View>
              <View style={{ height: 24, justifyContent: "center" }}><Bone width={84} /></View>
            </View>
            <Bone width={96} />
          </View>
        </Card>
      ))}
    </Skeleton>
  );
}

/** A project's home: its name, how it is doing, and the three tiles. */
export function SkeletonProject() {
  const { colors } = useTheme();
  return (
    <Skeleton style={{ flex: 1, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 20 }} testID="project-loading">
      {/* The header: room where the back arrow will be, then the project's icon and name. */}
      <View style={{ height: 44, marginBottom: 20, paddingLeft: 40, flexDirection: "row", alignItems: "center", gap: 8 }}><Bone width={32} height={32} radius={10} /><Bone width="52%" height={16} /></View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Bone width={48} height={48} />
        <View style={{ flex: 1 }}><View style={{ height: 24, justifyContent: "center" }}><Bone width="34%" /></View><Lines lines={2} /></View>
      </View>
      <View style={{ height: 44, marginTop: 4, marginBottom: 20, paddingLeft: 60, flexDirection: "row", alignItems: "center", gap: 20 }}><Bone width={68} /><Bone width={76} /></View>
      <View style={{ flex: 1, gap: 12 }}>
        {[1.65, 1, 1].map((flex, tile) => (
          <View key={tile} style={{ flex, justifyContent: "center", gap: 16, padding: 20, borderRadius: 20, borderWidth: 1, borderColor: colors.border }}>
            {tile === 0 && <Bone width={96} />}
            <Bone width={tile === 0 ? "30%" : "42%"} height={tile === 0 ? 28 : 20} />
            <Bone width="68%" />
          </View>
        ))}
      </View>
    </Skeleton>
  );
}

/** A list of issues or feature requests: three rows. */
export function SkeletonList({ rows = 3, style }: { rows?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Skeleton style={[{ gap: 12 }, style]} testID="list-loading">
      {Array.from({ length: rows }, (_, row) => (
        <Card key={row}>
          <Bone width="72%" height={16} />
          <View style={{ marginTop: 12 }}><Lines lines={2} /></View>
          <Bone width={88} height={20} style={{ marginTop: 12 }} />
        </Card>
      ))}
    </Skeleton>
  );
}

/** An issue: its title, what state it is in, its tabs, and the first of what it says. */
export function SkeletonCase({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Skeleton style={[{ padding: 16, gap: 20 }, style]} testID="issue-loading">
      <View style={{ gap: 12 }}><Bone width="88%" height={20} /><Bone width="54%" height={20} /></View>
      <View style={{ flexDirection: "row", gap: 8 }}><Bone width={92} height={24} /><Bone width={68} height={24} /></View>
      <Lines lines={4} />
      <Card><Bone width="40%" height={16} /><View style={{ marginTop: 12 }}><Lines lines={3} /></View></Card>
    </Skeleton>
  );
}
