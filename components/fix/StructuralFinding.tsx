import { useRef, useState } from "react";
import { View } from "react-native";
import { approvePreventionCheck } from "../../data";
import type { StructuralFinding } from "../../data/types";
import { useTheme } from "../../theme";
import { Button, Card, Icon, Sheet, T } from "../ui";
import { SpanText, type Sources } from "./Evidence";
import { kindLabel } from "./FixCard";

// The deeper cause on the Overview. It names its prevention check and where that check stands; approving the
// check happens on the Fixes screen, beside the fixes (PreventionCheckCard), never ahead of "Look at potential fixes".
export function StructuralFindingCard({ finding, sources, id }: { finding: StructuralFinding; sources: Sources; id: (name: string) => string }) {
  const { colors } = useTheme();
  const check = finding.check;
  return (
    <Card style={{ gap: 16 }} testID={id("structural-finding")}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="Layers" size={20} color="brandDeep" />
        <T variant="strong" style={{ flex: 1 }}>{"A deeper cause across " + finding.connectedCaseCount + " cases"}</T>
        <T variant="small" color="textMuted">{Math.round(finding.confidence * 100) + "% confident"}</T>
      </View>
      <T>{finding.hypothesis}</T>
      {finding.seededCaseCount > 0 && (
        <T variant="small" color="statusNeedsYou">
          {finding.seededCaseCount + " of these cases " + (finding.seededCaseCount === 1 ? "is a seeded sample" : "are seeded samples") + ", not real incidents."}
        </T>
      )}
      {finding.evidence.length > 0 && (
        <View style={{ gap: 12 }}>
          {finding.evidence.map((item, i) => (
            <View key={i} style={{ gap: 2, borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 12 }}>
              <T variant="small" color="textMuted">{item.label}</T>
              <SpanText spans={[{ text: item.text, ...(item.cite && { cite: item.cite }) }]} sources={sources} prefix={id("structural-evidence-" + i)} />
            </View>
          ))}
        </View>
      )}
      <T color="textMuted">{"It's ruled out if: " + finding.test.disprovedIf}</T>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Icon name="Wrench" size={18} color="brandDeep" />
        <View style={{ flex: 1, gap: 2 }}>
          {finding.change.fixKey ? (
            <>
              <T>{"Offered in Fixes: " + finding.change.title}</T>
              <T variant="small" color="textMuted">{kindLabel[finding.change.kind]}</T>
            </>
          ) : (
            <>
              <T>{finding.change.title}</T>
              <T variant="small" color="textMuted">{finding.change.note ?? "Not offered in Fixes yet."}</T>
            </>
          )}
        </View>
      </View>
      {check && (
        <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Icon name="ShieldCheck" size={18} color="brandDeep" />
            <T variant="strong" style={{ flex: 1 }}>{check.name}</T>
          </View>
          <T color="textMuted">{check.description}</T>
          {check.status === "offered" ? <T variant="small" color="textMuted" testID={id("structural-check-offered")}>Offered in Fixes, beside the fixes.</T> : <CheckStatus finding={finding} id={id} />}
        </View>
      )}
    </Card>
  );
}

function CheckStatus({ finding, id }: { finding: StructuralFinding; id: (name: string) => string }) {
  const check = finding.check;
  if (!check) return null;
  return (
    <View style={{ gap: 4 }} testID={id("structural-check-status")}>
      {check.status === "running" && <T color="statusWorking">turtl is running the check once…</T>}
      {check.status === "registered" && (
        <>
          <T color="statusClear">The monitor runs this check.</T>
          {check.lastResult && <T color={check.lastResult.verdict === "passed" ? "textMuted" : "statusAffected"}>{check.lastResult.summary}</T>}
        </>
      )}
      {check.status === "not_registered" && <T color="statusAffected">{check.reason ?? "Not registered."}</T>}
    </View>
  );
}

// The deeper cause's prevention check on the Fixes screen, where the owner approves it beside the fixes.
export function PreventionCheckCard({ finding, id }: { finding: StructuralFinding; id: (name: string) => string }) {
  const { colors } = useTheme();
  const pending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = finding.check;
  if (!check) return null;
  const close = () => { if (!pending.current) setConfirming(false); };
  const confirm = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await approvePreventionCheck(finding.id);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve this check. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 12, borderTopWidth: 1, borderColor: colors.border, paddingTop: 20, paddingBottom: 8 }} testID={id("structural-check")}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Icon name="Layers" size={16} color="brandDeep" />
        <T variant="small" color="brandDeep">From the deeper cause</T>
      </View>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: 6 }}>
          <T variant="strong">{check.name}</T>
          <T variant="small" color="textMuted">A check that keeps watching</T>
        </View>
        {check.status === "offered" && (
          <Button label="Approve" kind="outline" onPress={() => setConfirming(true)} testID={id("structural-check-approve")} style={{ minHeight: 44, paddingHorizontal: 14 }} />
        )}
      </View>
      <T color="textMuted">{check.description}</T>
      {check.status !== "offered" && <CheckStatus finding={finding} id={(name) => id("fixes-" + name)} />}
      <Sheet
        visible={confirming}
        onClose={close}
        title={"Approve: " + check.name + "?"}
        testID="structural-check-sheet"
        footer={
          <View style={{ gap: 12 }}>
            {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="structural-check-error">{error}</T>}
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button label="Cancel" kind="plain" disabled={busy} onPress={close} testID="structural-check-cancel" style={{ flex: 1 }} />
              <Button label={busy ? "Approving…" : "Approve"} disabled={busy} onPress={() => void confirm()} testID="structural-check-confirm" style={{ flex: 1 }} />
            </View>
          </View>
        }
      >
        <T>{check.description}</T>
        <T color="textMuted">turtl runs this check once now. If that run returns a result, the monitor runs it every minute, and a failure opens a case.</T>
      </Sheet>
    </View>
  );
}
