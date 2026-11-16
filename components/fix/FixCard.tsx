import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { approveFix, declineFixes } from "../../data";
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
      {fix.recommended && <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Icon name="Check" size={16} color="brandDeep" /><T variant="small" color="brandDeep">Recommended</T></View>}
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
        <Pressable
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          testID={prefix + "-toggle-" + fix.key}
          style={{ flex: 1, flexDirection: "row", gap: 8, minHeight: 44 }}
        >
          <View style={{ paddingTop: 3 }}><Icon name={open ? "ChevronDown" : "ChevronRight"} size={18} color="textMuted" /></View>
          <View style={{ flex: 1, gap: 6 }}>
            <T variant="strong" font="title">{(number ? number + ". " : "") + fix.title}</T>
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
          {fix.delivery === "pull_request" && <View style={{ flexDirection: "row", gap: 10, borderLeftWidth: 2, borderLeftColor: colors.brandDeep, paddingLeft: 12 }}><Icon name="GitPullRequest" size={18} color="brandDeep" /><T color="textMuted" style={{ flex: 1 }}>{pullRequestNote}</T></View>}
          <View style={{ gap: 4 }}>
            <T variant="strong">Why</T>
            <SpanText spans={fix.why} sources={sources} prefix={prefix + "-" + fix.key} />
          </View>
          {!!fix.preferences?.length && (
            <View style={{ gap: 8, borderLeftWidth: 2, borderLeftColor: colors.brandDeep, paddingLeft: 12 }} testID={prefix + "-preferences-" + fix.key}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name="MessageSquareQuote" size={18} color="brandDeep" /><T variant="strong">What you asked for</T></View>
              {fix.preferences.map((preference) => <T key={preference.id}>{"“" + preference.statement + "”"}</T>)}
              <T variant="small" color="textMuted">This is your preference, not evidence.</T>
            </View>
          )}
          {!!fix.pastDecisions && <View style={{ flexDirection: "row", gap: 8 }} testID={prefix + "-past-" + fix.key}><Icon name="History" size={18} color="textMuted" /><T color="textMuted" style={{ flex: 1 }}>{fix.pastDecisions}</T></View>}
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
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    setError(null);
    setNote("");
  }, [caseId, fix?.key]);
  const close = () => { if (!pending.current) onClose(); };
  const confirm = async () => {
    if (!fix || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await approveFix(caseId, fix.key, fix.recommended ? undefined : note.trim() || undefined);
      onClose();
      if (!stay) router.push(("/review/" + caseId + "/enacting") as never);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not approve this fix. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Sheet visible={!!fix} onClose={close} title={fix ? "Approve: " + fix.title + "?" : ""} testID="approve-sheet">
      {fix && (
        <>
          <T>{fix.whatChanges}</T>
          {fix.delivery === "pull_request" && <T testID="approve-pull-request-note">{pullRequestNote}</T>}
          <T color="textMuted">{fix.whatMightBeLost}</T>
          {!fix.recommended && <NoteInput label="Why this one? (optional)" placeholder="Anything turtl should remember" value={note} onChangeText={setNote} editable={!busy} testID="approve-note" />}
          {error && <T color="statusAffected" accessibilityRole="alert" testID="approve-error">{error}</T>}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button label="Cancel" kind="plain" disabled={busy} onPress={close} testID="approve-cancel" style={{ flex: 1 }} />
            <Button
              label={busy ? "Approving…" : "Approve"}
              disabled={busy}
              onPress={() => void confirm()}
              testID="approve-confirm"
              style={{ flex: 1 }}
            />
          </View>
        </>
      )}
    </Sheet>
  );
}

function NoteInput({ label, placeholder, value, onChangeText, editable, testID }: { label: string; placeholder: string; value: string; onChangeText: (value: string) => void; editable: boolean; testID: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <T variant="strong">{label}</T>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline
        maxLength={500}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        accessibilityLabel={label}
        testID={testID}
        style={{ minHeight: 88, textAlignVertical: "top", color: colors.text, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, fontSize: 16, fontFamily: "Capriola_400Regular" }}
      />
    </View>
  );
}

export function DeclineSheet({ caseId, visible, onClose }: { caseId: string; visible: boolean; onClose: () => void }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    setError(null);
    setNote("");
  }, [caseId, visible]);
  const close = () => { if (!pending.current) onClose(); };
  const confirm = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await declineFixes(caseId, note.trim() || undefined);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not decline these fixes. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} onClose={close} title="Decline these fixes?" testID="decline-sheet">
      <T>Nothing will be changed, and this case will close.</T>
      <NoteInput label="What should turtl know? (optional)" placeholder="Keep booking up" value={note} onChangeText={setNote} editable={!busy} testID="decline-note" />
      {error && <T color="statusAffected" accessibilityRole="alert" testID="decline-error">{error}</T>}
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Button label="Cancel" kind="plain" disabled={busy} onPress={close} testID="decline-cancel" style={{ flex: 1 }} />
        <Button label={busy ? "Declining…" : "Decline"} kind="danger" disabled={busy} onPress={() => void confirm()} testID="decline-confirm" style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}
