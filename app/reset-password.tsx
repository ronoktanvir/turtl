import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import Field from "../components/account/Field";
import FormScreen, { FormLink } from "../components/account/FormScreen";
import { legalLinks } from "../components/legal/links";
import { Button, Card, T } from "../components/ui";
import { CODE_VALID_HOURS, formatCode, MIN_PASSWORD_LENGTH, normalizeCode, normalizeEmail, passwordProblem, words } from "../convex/auth/rules";
import { useAccount, useAccountActions } from "../data/account";
import { forgetResetAddress, recentResetAddress, rememberResetAddress } from "../data/account/resetAddress";

const support = legalLinks.find((link) => link.id === "support")!.url;

/**
 * Reset a forgotten password with a code sent by email. The email's turtl://reset-password link opens this screen with
 * the code filled in, and only the code (finding 21): whose password changes comes from this phone's own request, or
 * from the person, never from the link, and the screen says it before the button. Nothing is sent until the person
 * chooses a password and taps Set new password. Without an email service on the backend, it says how to reach support.
 */
export default function ResetPassword() {
  const router = useRouter();
  const linked = useLocalSearchParams<{ emailCode?: string }>().emailCode;
  const { mode } = useAccount();
  const { requestReset, resetPassword } = useAccountActions();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  // The address this phone asked to reset (here, or earlier within a code's life); null when the person must type it.
  const [known, setKnown] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [fromLink, setFromLink] = useState(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A link fills the code in and goes to choosing a password. The address is this phone's own last request, if any.
  useEffect(() => {
    const given = typeof linked === "string" ? normalizeCode(linked) : null;
    if (!given) return;
    setCode(formatCode(given));
    setFromLink(true);
    setChoosing(true);
    setError(null);
    let current = true;
    void recentResetAddress().then((address) => {
      if (current) setKnown(address);
    });
    return () => {
      current = false;
    };
  }, [linked]);

  const run = async (work: () => Promise<string | null>, onDone?: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const message = await work();
    pending.current = false;
    setBusy(false);
    setError(message);
    if (!message) onDone?.();
  };
  const send = () => {
    const normalized = normalizeEmail(email);
    if (!normalized) return setError(words.badEmail);
    void run(
      () => requestReset(normalized),
      () => {
        void rememberResetAddress(normalized);
        setKnown(normalized);
        setFromLink(false);
        setChoosing(true);
      },
    );
  };
  const account = known ?? normalizeEmail(email);
  const change = () => {
    if (!account) return setError(words.badEmail);
    const problem = passwordProblem(password, account);
    if (problem) return setError(problem);
    if (!normalizeCode(code)) return setError(words.wrongResetCode);
    // On success the account gate opens Projects.
    void run(() => resetPassword(account, code, password), () => void forgetResetAddress());
  };
  const startAgain = () => {
    setCode("");
    setError(null);
    setFromLink(false);
    setChoosing(false);
  };

  if (!mode?.passwordReset) {
    return (
      <FormScreen title="Reset your password" testID="reset-password">
        <T testID="reset-unavailable">{words.resetOff}</T>
        <T color="textMuted">Write from the email address you signed up with, and say you can't log in.</T>
        <Button label="Contact support" icon="ExternalLink" onPress={() => void Linking.openURL(support)} testID="reset-contact-support" />
        <FormLink label="Back to log in" onPress={() => router.replace("/sign-in")} testID="reset-back" />
      </FormScreen>
    );
  }

  if (!choosing) {
    return (
      <FormScreen title="Reset your password" testID="reset-password">
        <T color="textMuted">Enter the email address you signed up with. turtl will email you a link and a code.</T>
        <Field label="Email" testID="reset-email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="username" autoComplete="email" editable={!busy} returnKeyType="send" onSubmitEditing={send} />
        {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="reset-error">{error}</T>}
        <Button label={busy ? "Sending…" : "Email me a code"} disabled={busy || !email} onPress={send} testID="reset-send" />
      </FormScreen>
    );
  }

  return (
    <FormScreen title="Reset your password" testID="reset-password">
      {fromLink ? (
        <T testID="reset-sent">The code from your email is filled in.</T>
      ) : (
        <T testID="reset-sent">If there's a turtl account for the address below, an email is on its way. Tap the link in it on this phone, or copy the code here. It works for {CODE_VALID_HOURS} hours.</T>
      )}
      {known ? (
        <Card testID="reset-account" style={{ paddingVertical: 14, paddingHorizontal: 16, gap: 2 }}>
          <T variant="small" color="textMuted">Account</T>
          <T variant="strong" font="text" selectable>{known}</T>
        </Card>
      ) : (
        <Field label="Email address of your account" testID="reset-account-email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="username" autoComplete="email" editable={!busy} />
      )}
      <Field label="Code from the email" testID="reset-code" code value={code} onChangeText={setCode} placeholder="Paste the code here" autoCapitalize="characters" textContentType="oneTimeCode" autoComplete="one-time-code" editable={!busy} />
      <Field label="New password" testID="reset-new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" autoComplete="new-password" editable={!busy} returnKeyType="go" onSubmitEditing={change} />
      <T variant="small" color="textMuted" testID="reset-whose">
        {account ? (
          <>
            This sets a new password for the turtl account <T font="text">{account}</T>. The code works only if turtl emailed it to that address.
          </>
        ) : (
          "Enter the email address of your turtl account. The code works only for the address turtl emailed it to."
        )}
      </T>
      {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="reset-error">{error}</T>}
      <Button label={busy ? "Saving…" : "Set new password"} disabled={busy || !account || !code || !password} onPress={change} testID="reset-submit" />
      {known && (
        <FormLink
          label="Not your account? Use another address"
          role="button"
          onPress={() => {
            setKnown(null);
            setEmail("");
            setError(null);
          }}
          testID="reset-other-address"
        />
      )}
      <FormLink label="Send a new code" onPress={startAgain} testID="reset-again" />
    </FormScreen>
  );
}
