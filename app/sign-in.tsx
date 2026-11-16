import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import Field from "../components/account/Field";
import FormScreen, { FormLink } from "../components/account/FormScreen";
import { Button, T } from "../components/ui";
import { normalizeEmail, words } from "../convex/auth/rules";
import { useAccountActions } from "../data/account";

/** Log in with email and password. On success the account gate opens Projects. */
export default function SignIn() {
  const router = useRouter();
  const { logIn } = useAccountActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (pending.current) return;
    if (!normalizeEmail(email)) return setError(words.badEmail);
    if (!password) return setError(words.wrongPassword);
    pending.current = true;
    setBusy(true);
    setError(null);
    const message = await logIn(email, password);
    pending.current = false;
    setBusy(false);
    setError(message);
  };
  return (
    <FormScreen title="Log in" testID="sign-in">
      <Field label="Email" testID="sign-in-email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="username" autoComplete="email" editable={!busy} returnKeyType="next" />
      <Field label="Password" testID="sign-in-password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" editable={!busy} returnKeyType="go" onSubmitEditing={() => void submit()} />
      {error && <T color="statusAffected" accessibilityRole="alert" testID="sign-in-error">{error}</T>}
      <Button label={busy ? "Logging in…" : "Log in"} disabled={busy || !email || !password} onPress={() => void submit()} testID="sign-in-submit" />
      <FormLink label="Forgot your password?" onPress={() => router.push("/reset-password")} testID="sign-in-forgot" />
      <FormLink label="New to turtl? Create an account" onPress={() => router.replace("/sign-up")} testID="sign-in-to-sign-up" />
    </FormScreen>
  );
}
