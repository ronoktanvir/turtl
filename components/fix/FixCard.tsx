import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { approveFix } from "../../data";
import type { FixKind, FixOption } from "../../data/types";
import { useTheme } from "../../theme";
import { Button, Card, Chip, Sheet, T } from "../ui";
import { SpanText, type Sources } from "./Evidence";

export const kindLabel: Record<FixKind, string> = {
  recovery: "Restore service now",
  repair: "Fix it properly",
  prevention: "Stop it happening again",
  change: "Build it",
};

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
    <Card
      style={{ gap: 12, borderColor: fix.recommended ? colors.brandDeep : colors.border }}
      testID={prefix + "-" + fix.key}
    >
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
        <Pressable
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          testID={prefix + "-toggle-" + fix.key}
          style={{ flex: 1, flexDirection: "row", gap: 8 }}
        >
          <T variant="strong" color="textMuted" style={{ width: 18 }}>
            {open ? "▾" : "▸"}
          </T>
          <View style={{ flex: 1, gap: 6 }}>
            <T variant="strong">{(number ? number + ". " : "") + fix.title}</T>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {fix.recommended && <Chip label="Recommended" tone="statusClear" />}
              <Chip label={kindLabel[fix.kind]} />
            </View>
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
        <View style={{ gap: 12 }}>
          <T>{fix.whatChanges}</T>
          <View style={{ gap: 4 }}>
            <T variant="strong">Why</T>
            <SpanText spans={fix.why} sources={sources} prefix={prefix + "-" + fix.key} />
          </View>
          <View style={{ gap: 4 }}>
            <T variant="strong">Trade-offs</T>
            <T>{fix.whatMightBeLost}</T>
          </View>
          <T color="textMuted">{"How turtl checks it: " + fix.howChecked}</T>
        </View>
      )}
    </Card>
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
