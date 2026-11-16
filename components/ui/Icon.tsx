import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Code2, ExternalLink, GitBranch, GitMerge, GitPullRequest, History, Layers, MessageCircle, MessageSquareQuote, Network, Plus, Search, Settings2, ShieldCheck, Sparkles, Star, Terminal, TriangleAlert, Wrench, X, Zap, ZoomIn, ZoomOut, Users, Info, type LucideIcon } from "lucide-react-native";
import { useTheme, type TokenName } from "../../theme";

const icons = { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Code2, ExternalLink, GitBranch, GitMerge, GitPullRequest, History, Layers, MessageCircle, MessageSquareQuote, Network, Plus, Search, Settings2, ShieldCheck, Sparkles, Star, Terminal, TriangleAlert, Wrench, X, Zap, ZoomIn, ZoomOut, Users, Info } satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof icons;
export function Icon({ name, size = 20, color = "text", strokeWidth = 1.7 }: { name: IconName; size?: number; color?: TokenName; strokeWidth?: number }) {
  const { colors } = useTheme();
  const Component = icons[name];
  return <Component size={size} color={colors[color]} strokeWidth={strokeWidth} />;
}
