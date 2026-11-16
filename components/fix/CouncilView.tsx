import { useState } from "react";
import { Pressable, View } from "react-native";
import { formatAgentCost, useAgentWork } from "../../data";
import { useTheme } from "../../theme";
import { Icon, Reveal, T } from "../ui";

function List({ title, items, testID }: { title: string; items: string[]; testID: string }) {
  if (!items.length) return null;
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <T variant="strong">{title}</T>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 8 }}>
          <T color="textMuted">•</T>
          <T style={{ flex: 1 }}>{item}</T>
        </View>
      ))}
    </View>
  );
}

// The council's consolidated view, on the Logs tab beside the runs that produced it (the Overview carries no council,
// per the UI contract). An input to the fixes; never proof, never approval. Models that did not take part are left
// out: their only note was about deployment settings, which an owner cannot act on here.
export function CouncilView({ caseId, prefix }: { caseId: string; prefix: string }) {
  const work = useAgentWork(caseId);
  const { colors } = useTheme();
  const [showMembers, setShowMembers] = useState(false);
  const council = work?.council;
  if (!council || council.status === "running") return null;
  const answered = council.members.filter((member) => member.status === "answered");
  const members = council.members.filter((member) => member.status !== "not_run");
  return (
    <Reveal>
      <View style={{ gap: 14, paddingBottom: 20, borderBottomWidth: 1, borderColor: colors.border }} testID={prefix + "council"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Icon name="Users" color="brandDeep" />
          <T variant="heading" accessibilityRole="header" style={{ flex: 1 }}>What other models think</T>
        </View>
        <View style={{ flexDirection: "row", gap: 10, padding: 12, borderRadius: 14, backgroundColor: colors.surface }}>
          <Icon name="Info" size={18} color="statusNeedsYou" />
          <T variant="small" style={{ flex: 1 }} testID={prefix + "council-notice"}>{council.notice}</T>
        </View>
        {council.status === "skipped" || council.status === "failed" ? (
          <T color="textMuted">{council.skippedReason ?? "The council did not complete."}</T>
        ) : (
          <>
            {council.summary && <T>{council.summary}</T>}
            <List title="Where they agree" items={council.agreements} testID={prefix + "council-agreements"} />
            <List title="Where they differ" items={council.disagreements} testID={prefix + "council-disagreements"} />
            <List title="What evidence is missing" items={council.missingEvidence} testID={prefix + "council-missing"} />
          </>
        )}
        <Pressable onPress={() => setShowMembers(!showMembers)} accessibilityRole="button" accessibilityLabel={answered.length + " models answered on their own. " + (showMembers ? "Hide" : "Show") + " what each one said"} accessibilityState={{ expanded: showMembers }} aria-expanded={showMembers} testID={prefix + "council-members-toggle"} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
          <Icon name={showMembers ? "ChevronDown" : "ChevronRight"} size={16} color="textMuted" />
          <T variant="small" color="textMuted" style={{ flex: 1 }}>{answered.length + " models answered on their own · " + formatAgentCost(council.costUsd)}</T>
        </Pressable>
        {showMembers && members.map((member, i) => (
          <View key={i} style={{ gap: 4, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: member.status === "answered" ? colors.brandDeep : colors.border }}>
            <T variant="small" color="textMuted">{member.label + (member.confidence !== undefined ? " · confidence " + Math.round(member.confidence * 100) + "%" : "")}</T>
            <T variant="small" color={member.status === "answered" ? "text" : "textMuted"}>{member.status === "answered" ? member.hypothesis ?? "No answer." : "Did not answer this time."}</T>
          </View>
        ))}
      </View>
    </Reveal>
  );
}
