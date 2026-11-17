import { useRouter, type Href } from "expo-router";
import { Pressable, View } from "react-native";
import { Glyph } from "../onboarding/Glyph";
import { useProject } from "../../data";
import { useOverview, type WatchedCheck } from "../../data/overview";
import { useTheme, type TokenName } from "../../theme";
import { Icon, T, ago } from "../ui";

// What turtl is watching on a project with nothing open: each check turtl runs and when it last passed (journey,
// health and readiness checks alike, each checked about once a minute), and the way to the map of the code. Shown in an empty Fix or Features list, and briefly on the project home:
// there the Investigate tile below it leads to the map, and the Preparation row already says when checks are not ready.

const state: Record<WatchedCheck["state"], { glyph: "CircleCheck" | "CircleX" | "CircleDashed"; color: TokenName }> = {
  passing: { glyph: "CircleCheck", color: "statusClear" },
  failing: { glyph: "CircleX", color: "statusAffected" },
  waiting: { glyph: "CircleDashed", color: "textMuted" },
};

/** The line under a check's name, and the end of its accessible label. */
export function checkLine(check: WatchedCheck, now: number): string {
  if (check.state === "failing") return check.notAnswering ? (check.notAnswering.notReady ? "Not ready" : "Not answering") : "Not passing";
  if (check.lastPassedAt === undefined) return "Not checked yet";
  return "Passed " + ago(check.lastPassedAt, now);
}

/** What an empty list and the project home say when turtl could not read the project's repository. */
export const UNREADABLE_LINE = "turtl couldn't read this project's repository, so it is not watching anything yet. Open Preparation to see why and read it again.";

// A check that has not run yet is neither passing nor failing, so it is counted apart: a new project's one check reads
// "1 check, not run yet", never "0 of 1 checks passing".
export function watchingSummary(checks: WatchedCheck[]): string {
  const ran = checks.filter((check) => check.state !== "waiting");
  const waiting = checks.length - ran.length;
  if (ran.length === 0) return waiting === 1 ? "1 check, not run yet" : waiting + " checks, not run yet";
  const passing = ran.filter((check) => check.state === "passing").length;
  const summary = passing === ran.length ? (ran.length === 1 ? "1 check passing" : "All " + ran.length + " checks passing") : passing + " of " + ran.length + " checks passing";
  return waiting ? summary + ", " + waiting + " not run yet" : summary;
}

export default function Watching({ projectId, rows = 4, brief = false, testID = "watching" }: { projectId: string; rows?: number; brief?: boolean; testID?: string }) {
  const overview = useOverview(projectId);
  const practice = useProject(projectId)?.practice === true;
  const router = useRouter();
  const { colors } = useTheme();
  if (!overview || (brief && !overview.checks.length && (overview.preparation === "in_progress" || overview.preparation === "unreadable"))) return null;
  const now = Date.now();
  const { checks, map, preparation } = overview;
  const shown = checks.slice(0, rows);
  const rest = checks.length - shown.length;
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, minHeight: 44, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: colors.border };

  return (
    <View testID={testID} style={{ borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
        {checks.some((check) => check.state === "failing") ? <Icon name="TriangleAlert" size={18} color="statusAffected" /> : <Icon name="ShieldCheck" size={18} color="brandDeep" />}
        <View style={{ flex: 1 }}>
          <T variant="heading" accessibilityRole="header">What turtl is watching</T>
          {checks.length > 0 && <T variant="small" color="textMuted" testID={testID + "-summary"}>{watchingSummary(checks)}</T>}
        </View>
      </View>
      {shown.map((check, index) => (
        <View key={check.id} testID={testID + "-check-" + index} accessible accessibilityLabel={check.name + ". " + checkLine(check, now)} style={{ ...row, alignItems: "flex-start", paddingVertical: 10 }}>
          <View style={{ paddingTop: 2 }}><Glyph name={state[check.state].glyph} size={17} color={state[check.state].color} /></View>
          <View style={{ flex: 1 }}>
            <T variant="small" numberOfLines={2}>{check.name}</T>
            <T variant="small" color={check.state === "failing" ? "statusAffected" : "textMuted"}>{checkLine(check, now)}</T>
          </View>
        </View>
      ))}
      {rest > 0 && !brief && <View style={row}><T variant="small" color="textMuted">{rest === 1 ? "1 more check" : rest + " more checks"}</T></View>}
      {checks.length === 0 && (preparation === "unreadable" ? (
        <Pressable testID={testID + "-unreadable"} accessibilityRole="link" accessibilityLabel="Open the preparation to read the repository again" onPress={() => router.push(("/project/" + projectId + "/prepare") as Href)} style={({ pressed }) => ({ ...row, paddingVertical: 10, backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}>
          <T variant="small" color="statusNeedsYou" style={{ flex: 1 }}>{UNREADABLE_LINE}</T>
          <Icon name="ChevronRight" size={16} color="statusNeedsYou" />
        </Pressable>
      ) : preparation === "in_progress" ? (
        <Pressable testID={testID + "-preparation"} accessibilityRole="link" accessibilityLabel="Open the preparation" onPress={() => router.push(("/project/" + projectId + "/prepare") as Href)} style={({ pressed }) => ({ ...row, paddingVertical: 10, backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}>
          <T variant="small" color="textMuted" style={{ flex: 1 }}>turtl is still preparing this project. Its checks show here once the preparation is merged.</T>
          <Icon name="ChevronRight" size={16} color="textMuted" />
        </Pressable>
      ) : (
        <View style={{ ...row, paddingVertical: 10 }}><T variant="small" color="textMuted" style={{ flex: 1 }} testID={testID + "-none"}>turtl has no checks for this project yet.</T></View>
      ))}
      {!brief && !practice && (
        <Pressable testID={testID + "-map"} accessibilityRole="link" accessibilityLabel="Open the map of your code" onPress={() => router.push(("/project/" + projectId + "/investigate") as Href)} style={({ pressed }) => ({ ...row, paddingVertical: 10, backgroundColor: pressed ? colors.surfaceRaised : "transparent" })}>
          <Icon name="Network" size={17} color="brandDeep" />
          <View style={{ flex: 1 }}>
            <T variant="small">Map of your code</T>
            <T variant="small" color="textMuted">{map ? map.parts + " parts in " + map.groups + (map.groups === 1 ? " group" : " groups") : "turtl has not mapped it yet"}</T>
          </View>
          <Icon name="ArrowRight" size={16} color="textMuted" />
        </Pressable>
      )}
    </View>
  );
}
