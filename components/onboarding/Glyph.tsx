import { CircleCheck, CircleDashed, CircleQuestionMark, ClipboardCheck, FileCode, Flag, HeartPulse, LifeBuoy, RefreshCw, Route, Gauge, TriangleAlert, CircleX, type LucideIcon } from "lucide-react-native";
import { useTheme, type TokenName } from "../../theme";

const icons = { CircleCheck, CircleDashed, CircleQuestionMark, ClipboardCheck, FileCode, Flag, HeartPulse, LifeBuoy, RefreshCw, Route, Gauge, TriangleAlert, CircleX } satisfies Record<string, LucideIcon>;
export type GlyphName = keyof typeof icons;

export function Glyph({ name, size = 18, color = "text" }: { name: GlyphName; size?: number; color?: TokenName }) {
  const { colors } = useTheme();
  const Component = icons[name];
  return <Component size={size} color={colors[color]} strokeWidth={1.8} />;
}
