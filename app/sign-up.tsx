import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import Field from "../components/account/Field";
import FormScreen, { FormLink } from "../components/account/FormScreen";
import LegalLinks from "../components/legal/LegalLinks";
import { Button, T } from "../components/ui";
import { MIN_PASSWORD_LENGTH, normalizeEmail, passwordProblem, words } from "../convex/auth/rules";
import { useAccountActions } from "../data/account";

/** Create an account with an email address and a password, and nothing else (checklist RC-17). */
export default function SignUp() {
  const router = useRouter();
  const { signUp } = useAccountActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (pending.current) return;
    const normalized = normalizeEmail(email);
    if (!normalized) return setError(words.badEmail);
    const problem = passwordProblem(password, normalized);
    if (problem) return setError(problem);
    pending.current = true;
    setBusy(true);
    setError(null);
    const message = await signUp(email, password);
    pending.current = false;
    setBusy(false);
    setError(message);
  };
  return (
    <FormScreen title="Create your account" testID="sign-up">
      <T color="textMuted">All turtl needs is an email address and a password.</T>
      <Field label="Email" testID="sign-up-email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="username" autoComplete="email" editable={!busy} returnKeyType="next" />
      <Field label="Password" testID="sign-up-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" autoComplete="new-password" editable={!busy} returnKeyType="go" onSubmitEditing={() => void submit()} />
      {error && <T color="statusAffected" accessibilityRole="alert" testID="sign-up-error">{error}</T>}
      {error === words.accountExists && <FormLink label="Log in instead" onPress={() => router.replace("/sign-in")} testID="sign-up-to-sign-in" />}
      <Button label={busy ? "Creating your account…" : "Create account"} disabled={busy || !email || !password} onPress={() => void submit()} testID="sign-up-submit" />
      <T variant="small" color="textMuted" style={{ textAlign: "center" }}>By creating an account you agree to the terms. The privacy policy says what turtl keeps.</T>
      <LegalLinks />
    </FormScreen>
  );
}
