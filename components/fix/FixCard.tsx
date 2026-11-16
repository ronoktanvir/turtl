import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { approveFix } from "../../data";
import type { FixKind, FixOption } from "../../data/types";
import { useTheme } from "../../theme";
import { Button, Icon, Sheet, T } from "../ui";
import { SpanText, type Sources } from "./Evidence";

export const kindLabel: Record<FixKind, string> = {
  recovery: "Restore service now",
  repair: "Fix it properly",
  prevention: "Stop it happening again",
  change: "Build it",
};

const pullRequestNote = "Approving opens a pull request. Nothing changes in the live app until it is merged.";

export function FixCard({
  fix,
  number,
  sources,
  defaultOpen,
  approveDisabled,
  onApprove,
  prefix = "fix",
}: {
  fix: FixOption;
  number?: number;
  sources: Sources;
  defaultOpen?: boolean;
  approveDisabled?: boolean;
  onApprove: (fix: FixOption) => void;
  prefix?: string;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <View
      style={{ gap: 16, borderTopWidth: 1, borderColor: fix.recommended ? colors.brandDeep : colors.border, paddingTop: 20, paddingBottom: 8 }}
      testID={prefix + "-" + fix.key}
    >
      {fix.recommended && <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Icon name="Sparkles" size={16} color="brandDeep" /><T variant="small" color="brandDeep" style={{ fontWeight: "700" }}>Recommended</T></View>}
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
        <Pressable
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          testID={prefix + "-toggle-" + fix.key}
          style={{ flex: 1, flexDirection: "row", gap: 8, minHeight: 44 }}
        >
          <View style={{ paddingTop: 3 }}><Icon name={open ? "ChevronDown" : "ChevronRight"} size={18} color="textMuted" /></View>
          <View style={{ flex: 1, gap: 6 }}>
            <T variant="strong">{(number ? number + ". " : "") + fix.title}</T>
            <T variant="small" color="textMuted">{kindLabel[fix.kind]}</T>
          </View>
        </Pressable>
        <Button
          label="Approve"
          kind={fix.recommended ? "primary" : "outline"}
          disabled={approveDisabled}
          onPress={() => onApprove(fix)}
          testID={prefix + "-approve-" + fix.key}
          style={{ minHeight: 44, paddingHorizontal: 14 }}
        />
      </View>
      {open && (
        <View style={{ gap: 20, paddingLeft: 26 }}>
          <T>{fix.whatChanges}</T>
          {fix.delivery === "pull_request" && <View style={{ flexDirection: "row", gap: 10, borderLeftWidth: 2, borderLeftColor: colors.brandDeep, paddingLeft: 12 }}><Icon name="GitPullRequest" size={18} color="brandDeep" /><T variant="small" color="textMuted" style={{ flex: 1 }}>{pullRequestNote}</T></View>}
          <View style={{ gap: 4 }}>
            <T variant="strong">Why</T>
            <SpanText spans={fix.why} sources={sources} prefix={prefix + "-" + fix.key} />
          </View>
          <View style={{ gap: 4 }}>
            <T variant="strong">Trade-offs</T>
            <T>{fix.whatMightBeLost}</T>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}><Icon name="ShieldCheck" size={18} color="brandDeep" /><T color="textMuted" style={{ flex: 1 }}>{"How turtl checks it: " + fix.howChecked}</T></View>
        </View>
      )}
    </View>
  );
}

export function ApproveSheet({
  caseId,
  fix,
  onClose,
  stay,
}: {
  caseId: string;
  fix: FixOption | null;
  onClose: () => void;
  stay?: boolean;
}) {
  const router = useRouter();
  return (
    <Sheet visible={!!fix} onClose={onClose} title={fix ? "Approve: " + fix.title + "?" : ""} testID="approve-sheet">
      {fix && (
        <>
          <T>{fix.whatChanges}</T>
          {fix.delivery === "pull_request" && <T testID="approve-pull-request-note">{pullRequestNote}</T>}
          <T color="textMuted">{fix.whatMightBeLost}</T>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button label="Cancel" kind="plain" onPress={onClose} testID="approve-cancel" style={{ flex: 1 }} />
            <Button
              label="Approve"
              onPress={async () => {
                await approveFix(caseId, fix.key);
                onClose();
                if (!stay) router.push(("/review/" + caseId + "/enacting") as never);
              }}
              testID="approve-confirm"
              style={{ flex: 1 }}
            />
          </View>
        </>
      )}
    </Sheet>
  );
}
