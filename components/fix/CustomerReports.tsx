import { useRef, useState } from "react";
import { View } from "react-native";
import { deleteCustomerReport, useCustomerReports, type CustomerReport } from "../../data/reports";
import { useTheme } from "../../theme";
import { ago, Button, Icon, Sheet, T } from "../ui";

// One self-contained control on a case raised by customers: a way to delete one customer's report. It reads the
// case's reports itself and shows nothing when there are none (and nothing with example data).
export function CustomerReportsControl({ caseId, id }: { caseId: string; id: (name: string) => string }) {
  const { colors } = useTheme();
  const data = useCustomerReports(caseId);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<CustomerReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!data?.reports.length && !done) return null;
  const reports = data?.reports ?? [];

  const close = () => {
    if (pending.current) return;
    setOpen(false);
    setConfirming(null);
    setError(null);
  };
  const remove = async (report: CustomerReport) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const counts = await deleteCustomerReport(caseId, report.id);
      setDone(`Deleted. This case now has ${counts.reportCount} ${counts.reportCount === 1 ? "message" : "messages"} from ${counts.people} ${counts.people === 1 ? "person" : "people"}.`);
      setConfirming(null);
      if (counts.reportCount === 0) setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this report. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 8 }} testID={id("customer-reports")}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="MessageSquareQuote" size={18} color="textMuted" />
        <T variant="small" color="textMuted" style={{ flex: 1 }}>
          {reports.length + (reports.length === 1 ? " customer message" : " customer messages") + " on this case"}
        </T>
        {reports.length > 0 && (
          <Button
            kind="plain"
            label="Manage"
            onPress={() => { setDone(null); setOpen(true); }}
            testID={id("customer-reports-manage")}
          />
        )}
      </View>
      {done && !open && <T variant="small" color="textMuted" accessibilityRole="alert" testID={id("customer-reports-done")}>{done}</T>}
      <Sheet visible={open} onClose={close} title={confirming ? "Delete this report?" : "Customers' reports"} testID={id("customer-reports-sheet")}>
        {confirming ? (
          <View style={{ gap: 16 }}>
            <View style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 12 }}>
              <T>{'"' + confirming.text + '"'}</T>
            </View>
            <T color="textMuted">
              turtl deletes these words, its search copy of them, and their quotes in this case. The case's counts go down by one. This cannot be undone. The case itself stays.
            </T>
            {error && <T color="statusAffected" accessibilityRole="alert" testID={id("customer-report-delete-error")}>{error}</T>}
            <View style={{ gap: 10 }}>
              <Button kind="danger" label={busy ? "Deleting…" : "Delete report"} disabled={busy} onPress={() => remove(confirming)} testID={id("customer-report-delete-confirm")} />
              <Button kind="plain" label="Keep it" disabled={busy} onPress={() => { setConfirming(null); setError(null); }} testID={id("customer-report-delete-cancel")} />
            </View>
          </View>
        ) : (
          <View style={{ gap: 16 }}>
            <T color="textMuted">
              Delete a report you should not keep, for example one where a customer wrote personal details, or when a customer asks you to.
            </T>
            {done && <T variant="small" color="textMuted" accessibilityRole="alert">{done}</T>}
            {reports.map((report, i) => (
              <View key={report.id} style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 }} testID={id("customer-report-" + i)}>
                <T numberOfLines={4}>{'"' + report.text + '"'}</T>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <T variant="small" color="textMuted">{"Sent " + ago(report.receivedAt)}</T>
                  <Button
                    kind="danger"
                    label="Delete"
                    onPress={() => { setDone(null); setError(null); setConfirming(report); }}
                    testID={id("customer-report-delete-" + i)}
                  />
                </View>
              </View>
            ))}
          </View>
        )}
      </Sheet>
    </View>
  );
}
