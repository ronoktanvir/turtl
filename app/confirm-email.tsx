import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Field from "../components/account/Field";
import FormScreen, { FormLink } from "../components/account/FormScreen";
import { Button, Card, T } from "../components/ui";
import { formatCode, normalizeCode, UNCONFIRMED_DAYS, words } from "../convex/auth/rules";
import { rememberLinkedCode, takeLinkedCode, useAccount, useAccountActions, useConfirmation } from "../data/account";

type Busy = "confirm" | "resend" | "leave" | null;

/**
 * The one screen a password account sees until it confirms its email address (convex/auth/confirmation.ts). The
 * email's turtl://confirm-email link opens it with the code filled in; nothing is sent until the person taps Confirm
 * email. Confirming opens Projects; the account gate does that once the backend says the address is confirmed.
 */
export default function ConfirmEmail() {
  const linked = useLocalSearchParams<{ emailCode?: string }>().emailCode;
  const { status, viewer } = useAccount();
  const confirmation = useConfirmation();
  const { confirmEmail, resendConfirmation, startOver, signOut } = useAccountActions();
  const [code, setCode] = useState("");
  const [fromLink, setFromLink] = useState(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // A link fills the code in: here, or, when it opened while nobody was signed in on this phone, after logging in.
  useEffect(() => {
    const given = typeof linked === "string" ? normalizeCode(linked) : null;
    if (given && status !== "unconfirmed") rememberLinkedCode(given);
    const filled = given ?? (status === "unconfirmed" ? takeLinkedCode() : null);
    if (!filled) return;
    setCode(formatCode(filled));
    setFromLink(true);
    setError(null);
  }, [linked, status]);

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<string | null>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    setError(null);
    setNote(null);
    const message = await work();
    pending.current = false;
    setBusy(null);
    setError(message);
  };
  const confirm = () => {
    if (!normalizeCode(code)) return setError(words.wrongCode);
    void run("confirm", () => confirmEmail(code));
  };
  const resend = () =>
    void run("resend", async () => {
      const answer = await resendConfirmation();
      setNote(answer.message);
      return null;
    });
  const leave = (action: () => Promise<string | null>) => () => void run("leave", action);
  const email = confirmation?.email ?? viewer?.email ?? null;

  return (
    <FormScreen title="Check your email" testID="confirm-email" back={false}>
      <T>turtl sent a link and a code to confirm your email address. Open the email on this phone and tap the link, or copy the code into the box below.</T>
      {email && (
        <Card testID="confirm-address" style={{ paddingVertical: 14, paddingHorizontal: 16, gap: 2 }}>
          <T variant="small" color="textMuted">Sent to</T>
          <T variant="strong" font="text" selectable>{email}</T>
        </Card>
      )}
      <Field
        label="Code from the email"
        testID="confirm-code"
        code
        value={code}
        onChangeText={(text) => {
          setCode(text);
          setFromLink(false);
        }}
        placeholder="Paste the code here"
        autoCapitalize="characters"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        editable={busy === null}
        returnKeyType="go"
        onSubmitEditing={confirm}
      />
      {fromLink && <T variant="small" color="textMuted" testID="confirm-from-link">The code from your email is filled in. Tap Confirm email.</T>}
      {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="confirm-error">{error}</T>}
      <Button label={busy === "confirm" ? "Confirming…" : "Confirm email"} disabled={busy !== null || !code.trim()} onPress={confirm} testID="confirm-submit" />
      <View style={{ gap: 8 }}>
        <T variant="small" color="textMuted">No email? It can take a minute to arrive, so check your spam folder too.</T>
        <Button label={busy === "resend" ? "Sending…" : "Send the email again"} kind="plain" disabled={busy !== null} onPress={resend} testID="confirm-resend" />
        {note && <T font="text" accessibilityRole="alert" testID="confirm-note">{note}</T>}
      </View>
      <View>
        <FormLink label="Wrong email address? Start again" role="button" disabled={busy !== null} onPress={leave(startOver)} testID="confirm-start-over" />
        <FormLink label="Sign out" role="button" disabled={busy !== null} onPress={leave(signOut)} testID="confirm-sign-out" />
      </View>
      <T variant="small" color="textMuted" style={{ textAlign: "center" }}>
        Until you confirm, this account can't do anything. If it isn't confirmed within {UNCONFIRMED_DAYS} days, turtl deletes it.
      </T>
    </FormScreen>
  );
}
