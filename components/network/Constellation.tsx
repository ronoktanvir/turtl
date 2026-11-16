import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { PanResponder, Platform, Pressable, View, type GestureResponderEvent } from "react-native";
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from "react-native-svg";
import type { CodeNetwork } from "../../data/types";
import { useTheme } from "../../theme";
import { Icon, T, useReducedMotion } from "../ui";

export type NetworkSelection = { kind: "cluster" | "node"; id: string } | null;
type Point = { x: number; y: number };
type Camera = Point & { scale: number };
const WORLD = { width: 640, height: 800 };
const clamp = (scale: number) => Math.max(0.45, Math.min(2.5, scale));
const anchors: Point[] = [{ x: 160, y: 200 }, { x: 465, y: 180 }, { x: 105, y: 470 }, { x: 510, y: 490 }, { x: 315, y: 705 }, { x: 310, y: 420 }];

export function Constellation({ network, selection, onSelect }: { network: CodeNetwork; selection: NetworkSelection; onSelect: (selection: NetworkSelection) => void }) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const viewport = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 360, height: 480 });
  const previousSize = useRef(size);
  const [camera, setCamera] = useState<Camera>({ x: 20, y: 0, scale: 0.5 });
  const current = useRef(camera);
  const animation = useRef<number | null>(null);
  const animationTarget = useRef<Camera | null>(null);
  const touched = useRef(false);
  const gesture = useRef<{ count: number; point: Point; distance: number; camera: Camera } | null>(null);
  const layout = useMemo(() => {
    const clusters = new Map<string, Point>();
    const nodes = new Map<string, Point>();
    network.clusters.forEach((cluster, index) => {
      const center = anchors[index] ?? { x: 320 + Math.cos(index * 2.4) * 210, y: 400 + Math.sin(index * 2.4) * 290 };
      clusters.set(cluster.id, center);
      const members = network.nodes.filter((n) => n.clusterId === cluster.id).sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
      members.forEach((node, i) => {
        const angle = i * 2.39996 + index * 0.78;
        const radius = i === 0 ? 0 : 63 + Math.sqrt(i) * 17;
        nodes.set(node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius * 0.8 });
      });
    });
    return { clusters, nodes };
  }, [network]);

  const update = (next: Camera) => { current.current = next; setCamera(next); };
  const stop = () => { if (animation.current !== null) cancelAnimationFrame(animation.current); animation.current = null; animationTarget.current = null; };
  const moveTo = (next: Camera) => {
    stop();
    if (reducedMotion) { update(next); return; }
    animationTarget.current = next;
    const start = current.current;
    const began = Date.now();
    const frame = () => {
      const progress = Math.min(1, (Date.now() - began) / 280);
      const eased = 1 - (1 - progress) ** 3;
      update({ x: start.x + (next.x - start.x) * eased, y: start.y + (next.y - start.y) * eased, scale: start.scale + (next.scale - start.scale) * eased });
      if (progress < 1) animation.current = requestAnimationFrame(frame);
      else { animation.current = null; animationTarget.current = null; }
    };
    animation.current = requestAnimationFrame(frame);
  };
  const fit = () => {
    const scale = clamp(Math.min((size.width - 32) / WORLD.width, (size.height - 44) / WORLD.height));
    return { scale, x: (size.width - WORLD.width * scale) / 2, y: (size.height - WORLD.height * scale) / 2 - 4 };
  };
  useEffect(() => {
    if (!touched.current) update(fit());
    else {
      const target = animationTarget.current ?? current.current;
      const next = { ...target, x: target.x + (size.width - previousSize.current.width) / 2, y: target.y + (size.height - previousSize.current.height) * 0.46 };
      if (animationTarget.current) moveTo(next);
      else update(next);
    }
    previousSize.current = size;
    viewport.current?.measureInWindow((x, y) => { origin.current = { x, y }; });
  }, [size.width, size.height]);
  useEffect(() => () => stop(), []);

  const touchState = (event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    if (!touches.length) return null;
    const a = touches[0];
    const b = touches[1] ?? a;
    return { count: touches.length, point: { x: (a.pageX + b.pageX) / 2 - origin.current.x, y: (a.pageY + b.pageY) / 2 - origin.current.y }, distance: Math.hypot(b.pageX - a.pageX, b.pageY - a.pageY) };
  };
  const begin = (event: GestureResponderEvent) => {
    stop();
    touched.current = true;
    const touch = touchState(event);
    gesture.current = touch ? { ...touch, camera: current.current } : null;
  };
  const handlers = useRef({ begin, touchState, update, stop });
  handlers.current = { begin, touchState, update, stop };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length > 1,
    onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length > 1,
    onMoveShouldSetPanResponderCapture: (_, state) => state.numberActiveTouches > 1 || Math.abs(state.dx) + Math.abs(state.dy) > 5,
    onPanResponderGrant: (event) => handlers.current.begin(event),
    onPanResponderStart: (event) => handlers.current.begin(event),
    onPanResponderMove: (event) => {
      const touch = handlers.current.touchState(event);
      const start = gesture.current;
      if (!touch) return;
      if (!start || touch.count !== start.count) { handlers.current.begin(event); return; }
      const scale = touch.count > 1 && start.distance > 0 ? clamp(start.camera.scale * touch.distance / start.distance) : start.camera.scale;
      const ratio = scale / start.camera.scale;
      handlers.current.update({ scale, x: touch.point.x - (start.point.x - start.camera.x) * ratio, y: touch.point.y - (start.point.y - start.camera.y) * ratio });
    },
    onPanResponderEnd: (event) => handlers.current.begin(event),
    onPanResponderRelease: () => { gesture.current = null; },
    onPanResponderTerminate: () => { gesture.current = null; },
    onPanResponderTerminationRequest: () => false,
  }), []);
  const select = (next: NonNullable<NetworkSelection>, point: Point) => {
    touched.current = true;
    onSelect(next);
    const scale = next.kind === "cluster" ? 1.05 : 1.55;
    moveTo({ scale, x: size.width / 2 - point.x * scale, y: size.height * 0.46 - point.y * scale });
  };
  const zoom = (factor: number) => {
    touched.current = true;
    const scale = clamp(current.current.scale * factor);
    const ratio = scale / current.current.scale;
    moveTo({ scale, x: size.width / 2 - (size.width / 2 - current.current.x) * ratio, y: size.height / 2 - (size.height / 2 - current.current.y) * ratio });
  };
  const clusterId = selection?.kind === "cluster" ? selection.id : network.nodes.find((n) => n.id === selection?.id)?.clusterId;
  const related = new Set<string>();
  if (selection?.kind === "node") {
    related.add(selection.id);
    network.edges.forEach((edge) => {
      if (edge.from === selection.id) related.add(edge.to);
      if (edge.to === selection.id) related.add(edge.from);
    });
  } else if (selection) network.nodes.filter((n) => n.clusterId === selection.id).forEach((n) => related.add(n.id));
  const projected = (point: Point) => ({ x: camera.x + point.x * camera.scale, y: camera.y + point.y * camera.scale });
  const labelBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const occupied = network.clusters.map((cluster) => {
    const center = layout.clusters.get(cluster.id)!;
    const point = projected({ x: center.x, y: center.y - 130 });
    const width = cluster.name.length > 13 ? 176 : 120;
    return { x: point.x - width / 2, y: point.y - 14, width, height: 28 };
  });
  const nodeCircles = network.nodes.flatMap((node) => {
    const point = layout.nodes.get(node.id);
    return point ? [{ ...projected(point), radius: (14 + (node.weight ?? 1) * 5) * camera.scale }] : [];
  });
  if (camera.scale >= 0.85) {
    const candidates = network.nodes.filter((node) => !selection || related.has(node.id)).sort((a, b) => Number(b.id === selection?.id) - Number(a.id === selection?.id) || (b.weight ?? 1) - (a.weight ?? 1));
    candidates.forEach((node) => {
      const point = layout.nodes.get(node.id);
      const center = layout.clusters.get(node.clusterId);
      if (!point || !center) return;
      const screen = projected(point);
      const radius = (14 + (node.weight ?? 1) * 5) * camera.scale;
      const above = Math.hypot(point.x - center.x, point.y - center.y) > 20 && point.y <= center.y + 15;
      const width = 160;
      const height = 64;
      for (const gap of [8, 28, 56]) {
        const positions = [
          { x: screen.x - width / 2, y: screen.y + radius + gap },
          { x: screen.x - width / 2, y: screen.y - radius - gap - height },
          { x: screen.x + radius + gap, y: screen.y - height / 2 },
          { x: screen.x - radius - gap - width, y: screen.y - height / 2 },
        ];
        if (above) [positions[0], positions[1]] = [positions[1], positions[0]];
        const position = positions.find((box) =>
          box.x >= 8 && box.y >= 8 && box.x + width <= size.width - 8 && box.y + height <= size.height - 62 &&
          !nodeCircles.some((circle) => Math.hypot(circle.x - Math.max(box.x, Math.min(circle.x, box.x + width)), circle.y - Math.max(box.y, Math.min(circle.y, box.y + height))) < circle.radius + 4) &&
          !occupied.some((other) => box.x < other.x + other.width + 4 && box.x + width + 4 > other.x && box.y < other.y + other.height + 4 && box.y + height + 4 > other.y)
        );
        if (position) {
          const box = { ...position, width, height };
          labelBoxes.set(node.id, box);
          occupied.push(box);
          break;
        }
      }
    });
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }} testID="network-scroll-x">
      <View ref={viewport} testID="network-scroll-y" onLayout={(event) => setSize(event.nativeEvent.layout)} {...responder.panHandlers} style={[{ flex: 1, overflow: "hidden" }, Platform.OS === "web" ? { touchAction: "none" } as never : null]}>
        <Svg width={size.width} height={size.height} pointerEvents="none">
          <Defs>
            <RadialGradient id="network-halo"><Stop offset="0" stopColor={colors.brandDeep} stopOpacity={0.16} /><Stop offset="0.55" stopColor={colors.brandDeep} stopOpacity={0.06} /><Stop offset="1" stopColor={colors.brandDeep} stopOpacity={0} /></RadialGradient>
          </Defs>
          <G transform={`translate(${camera.x}, ${camera.y}) scale(${camera.scale})`}>
            {network.clusters.map((cluster, i) => {
              const p = layout.clusters.get(cluster.id)!;
              return <G key={cluster.id} opacity={!selection || clusterId === cluster.id ? 1 : 0.4}><Circle cx={p.x} cy={p.y} r={138 + (i % 3) * 9} fill="url(#network-halo)" /><Circle cx={p.x + 28} cy={p.y - 15} r={98} fill="url(#network-halo)" /></G>;
            })}
            {network.edges.map((edge, index) => {
              const a = layout.nodes.get(edge.from);
              const b = layout.nodes.get(edge.to);
              if (!a || !b) return null;
              const active = !!selection && (selection.kind === "node" ? edge.from === selection.id || edge.to === selection.id : related.has(edge.from) && related.has(edge.to));
              const bend = (index % 2 ? 1 : -1) * Math.min(35, Math.hypot(b.x - a.x, b.y - a.y) * 0.12);
              return <Path key={`${edge.from}-${edge.to}-${index}`} d={`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 + bend} ${(a.y + b.y) / 2 - bend} ${b.x} ${b.y}`} fill="none" stroke={active ? colors.brandDeep : colors.textMuted} strokeWidth={(active ? 1.6 : 0.8) / camera.scale} opacity={active ? 0.95 : selection ? 0.12 : 0.32} />;
            })}
            {network.nodes.map((node) => {
              const p = layout.nodes.get(node.id);
              if (!p) return null;
              const selected = selection?.kind === "node" && selection.id === node.id;
              const radius = 7 + (node.weight ?? 1) * 5;
              return <G key={node.id} opacity={!selection || related.has(node.id) ? 1 : 0.3}>
                <Circle cx={p.x} cy={p.y} r={radius + 7} fill={colors.brandDeep} opacity={selected ? 0.24 : 0.08} />
                <Circle cx={p.x} cy={p.y} r={radius} fill={(node.weight ?? 1) > 1 ? colors.brand : colors.surfaceRaised} stroke={selected ? colors.text : colors.brandDeep} strokeWidth={1.2 / camera.scale} />
                <Circle cx={p.x} cy={p.y} r={2.5} fill={(node.weight ?? 1) > 1 ? colors.brandDeep : colors.brand} />
              </G>;
            })}
          </G>
          {network.nodes.map((node) => {
            const box = labelBoxes.get(node.id);
            const point = layout.nodes.get(node.id);
            if (!box || !point) return null;
            const screen = projected(point);
            const x = Math.max(box.x, Math.min(screen.x, box.x + box.width));
            const y = Math.max(box.y, Math.min(screen.y, box.y + box.height));
            return <Path key={`label-${node.id}`} d={`M ${screen.x} ${screen.y} L ${x} ${y}`} stroke={colors.textMuted} strokeWidth={0.7} opacity={0.45} />;
          })}
        </Svg>
        {network.clusters.map((cluster) => {
          const p = layout.clusters.get(cluster.id)!;
          const screen = projected({ x: p.x, y: p.y - 130 });
          const labelWidth = cluster.name.length > 13 ? 176 : 120;
          return <Pressable key={cluster.id} testID={`network-cluster-${cluster.id}`} accessibilityRole="button" accessibilityLabel={`Cluster ${cluster.name}`} accessibilityState={{ selected: clusterId === cluster.id }} onPress={() => select({ kind: "cluster", id: cluster.id }, p)} style={{ position: "absolute", left: screen.x - labelWidth / 2, top: screen.y - 18, width: labelWidth, minHeight: 44, alignItems: "center", justifyContent: "center", opacity: !selection || clusterId === cluster.id ? 1 : 0.45 }}>
            <View style={{ backgroundColor: colors.surface, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}><T variant="small" style={{ fontSize: 13, textAlign: "center" }}>{cluster.name}</T></View>
          </Pressable>;
        })}
        {network.nodes.map((node) => {
          const p = layout.nodes.get(node.id);
          if (!p) return null;
          const screen = projected(p);
          return <Pressable key={node.id} testID={`network-node-${node.id}`} accessibilityRole="button" accessibilityLabel={`${node.label}, ${node.kind}`} accessibilityState={{ selected: selection?.kind === "node" && selection.id === node.id }} onPress={() => select({ kind: "node", id: node.id }, p)} style={{ position: "absolute", left: screen.x - 22, top: screen.y - 22, width: 44, height: 44, alignItems: "center", justifyContent: "center" }} />;
        })}
        {network.nodes.map((node) => {
          const box = labelBoxes.get(node.id);
          return box ? <View key={node.id} pointerEvents="none" style={{ position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height, paddingHorizontal: 8, justifyContent: "center", borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}><T variant="small" style={{ fontSize: 12, lineHeight: 17, textAlign: "center" }}>{node.label}</T></View> : null;
        })}
      </View>
      <View pointerEvents="box-none" style={{ position: "absolute", bottom: 12, left: 20, right: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View pointerEvents="none" style={{ flex: 1 }}><T variant="small" color="textMuted" style={{ fontSize: 12 }}>{selection ? "Follow the connections" : "Drag to explore · pinch to zoom"}</T></View>
        <View style={{ flexDirection: "row", borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
          <Pressable testID="network-zoom-out" accessibilityRole="button" accessibilityLabel="Zoom out" onPress={() => zoom(1 / 1.3)} style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="ZoomOut" size={18} color="textMuted" /></Pressable>
          <Pressable testID="network-reset" accessibilityRole="button" accessibilityLabel="Reset network view" onPress={() => { touched.current = false; onSelect(null); moveTo(fit()); }} style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="Network" size={18} color="brandDeep" /></Pressable>
          <Pressable testID="network-zoom-in" accessibilityRole="button" accessibilityLabel="Zoom in" onPress={() => zoom(1.3)} style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="ZoomIn" size={18} color="textMuted" /></Pressable>
        </View>
      </View>
    </View>
  );
}
