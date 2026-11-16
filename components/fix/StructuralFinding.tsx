import { useRef, useState } from "react";
import { View } from "react-native";
import { approvePreventionCheck } from "../../data";
import type { StructuralFinding } from "../../data/types";
import { useTheme } from "../../theme";
import { Button, Card, Icon, Sheet, T } from "../ui";
import { SpanText, type Sources } from "./Evidence";
import { kindLabel } from "./FixCard";

export function StructuralFindingCard({ finding, sources, id }: { finding: StructuralFinding; sources: Sources; id: (name: string) => string }) {
  const { colors } = useTheme();
  const pending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = finding.check;
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
          {check.status === "offered" ? (
            <Button label="Approve" kind="outline" onPress={() => setConfirming(true)} testID={id("structural-check-approve")} />
          ) : (
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
          )}
          <Sheet visible={confirming} onClose={close} title={"Approve: " + check.name + "?"} testID="structural-check-sheet">
            <T>{check.description}</T>
            <T color="textMuted">turtl runs this check once now. If that run returns a result, the monitor runs it every minute, and a failure opens a case.</T>
            {error && <T color="statusAffected" accessibilityRole="alert" testID="structural-check-error">{error}</T>}
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button label="Cancel" kind="plain" disabled={busy} onPress={close} testID="structural-check-cancel" style={{ flex: 1 }} />
              <Button label={busy ? "Approving…" : "Approve"} disabled={busy} onPress={() => void confirm()} testID="structural-check-confirm" style={{ flex: 1 }} />
            </View>
          </Sheet>
        </View>
      )}
    </Card>
  );
}
