import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import Field from "../components/account/Field";
import FormScreen, { FormLink } from "../components/account/FormScreen";
import { legalLinks } from "../components/legal/links";
import { Button, T } from "../components/ui";
import { CODE_VALID_HOURS, formatCode, MIN_PASSWORD_LENGTH, normalizeCode, normalizeEmail, passwordProblem, words } from "../convex/auth/rules";
import { useAccount, useAccountActions } from "../data/account";

const support = legalLinks.find((link) => link.id === "support")!.url;

/** Reset a forgotten password with a code sent by email. The email's turtl://reset-password link opens this screen
 * with the address and the code filled in; nothing is sent until the person chooses a password and taps Set new
 * password. Without an email service on the backend, it says how to reach support instead. */
export default function ResetPassword() {
  const router = useRouter();
  const linked = useLocalSearchParams<{ email?: string; emailCode?: string }>();
  const { mode } = useAccount();
  const { requestReset, resetPassword } = useAccountActions();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fromLink, setFromLink] = useState(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A link fills the address and the code in, and goes straight to choosing a password.
  useEffect(() => {
    const address = typeof linked.email === "string" ? normalizeEmail(linked.email) : null;
    const given = typeof linked.emailCode === "string" ? normalizeCode(linked.emailCode) : null;
    if (!address || !given) return;
    setEmail(address);
    setSentTo(address);
    setCode(formatCode(given));
    setFromLink(true);
    setError(null);
  }, [linked.email, linked.emailCode]);

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
    void run(() => requestReset(normalized), () => setSentTo(normalized));
  };
  const change = () => {
    if (!sentTo) return;
    const problem = passwordProblem(password, sentTo);
    if (problem) return setError(problem);
    if (!normalizeCode(code)) return setError(words.wrongCode);
    // On success the account gate opens Projects.
    void run(() => resetPassword(sentTo, code, password));
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

  return (
    <FormScreen title="Reset your password" testID="reset-password">
      {sentTo === null ? (
        <>
          <T color="textMuted">Enter the email address you signed up with. turtl will email you a link and a code.</T>
          <Field label="Email" testID="reset-email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="username" autoComplete="email" editable={!busy} returnKeyType="send" onSubmitEditing={send} />
          {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="reset-error">{error}</T>}
          <Button label={busy ? "Sending…" : "Email me a code"} disabled={busy || !email} onPress={send} testID="reset-send" />
        </>
      ) : (
        <>
          {fromLink ? (
            <T testID="reset-sent">The code from your email is filled in. Choose a new password for <T font="text">{sentTo}</T>.</T>
          ) : (
            <T testID="reset-sent">
              If there's an account for <T font="text">{sentTo}</T>, an email is on its way. Tap the link in it on this phone, or copy the code here. It works for {CODE_VALID_HOURS} hours.
            </T>
          )}
          <Field label="Code from the email" testID="reset-code" code value={code} onChangeText={setCode} placeholder="Paste the code here" autoCapitalize="characters" textContentType="oneTimeCode" autoComplete="one-time-code" editable={!busy} />
          <Field label="New password" testID="reset-new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" autoComplete="new-password" editable={!busy} returnKeyType="go" onSubmitEditing={change} />
          {error && <T font="text" color="statusAffected" accessibilityRole="alert" testID="reset-error">{error}</T>}
          <Button label={busy ? "Saving…" : "Set new password"} disabled={busy || !code || !password} onPress={change} testID="reset-submit" />
          <FormLink label="Send a new code" onPress={() => { setCode(""); setError(null); setFromLink(false); setSentTo(null); }} testID="reset-again" />
        </>
      )}
    </FormScreen>
  );
}
