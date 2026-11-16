import { useRef, useState } from "react";
import { View } from "react-native";
import { useAccount, useAccountActions, type SignInMethod } from "../../data/account";
import { Button, T } from "../ui";
import ProfilePicture from "./ProfilePicture";

const methodWords: Record<SignInMethod, string> = { password: "email and password", apple: "Apple", github: "GitHub" };

export function signedInWith(methods: SignInMethod[]): string {
  const named = methods.map((method) => methodWords[method]);
  if (named.length === 0) return "Signed in";
  return `Signed in with ${named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}`}`;
}

/** The gear sheet's account section: who is signed in, how, and Sign out. Nothing without accounts. */
export default function AccountSection({ heading = true }: { heading?: boolean }) {
  const { status, viewer } = useAccount();
  const { signOut } = useAccountActions();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status !== "signedIn") return null;
  const leave = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const message = await signOut();
    pending.current = false;
    setBusy(false);
    setError(message);
  };
  const title = viewer?.name ?? viewer?.email ?? "Your account";
  return (
    <View testID="account-section" style={{ gap: 12, marginTop: 8 }}>
      {heading && <T variant="heading">Account</T>}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <ProfilePicture size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="strong" numberOfLines={1} testID="account-name">{title}</T>
          {viewer?.name && viewer.email && <T variant="small" color="textMuted" numberOfLines={1} testID="account-email">{viewer.email}</T>}
          <T variant="small" color="textMuted" testID="account-methods">{viewer ? signedInWith(viewer.methods) : "Signed in"}</T>
        </View>
      </View>
      {error && <T color="statusAffected" accessibilityRole="alert" testID="account-sign-out-error">{error}</T>}
      <Button label={busy ? "Signing out…" : "Sign out"} kind="plain" disabled={busy} onPress={() => void leave()} testID="account-sign-out" />
      {/*
        Delete account goes here (checklist RC-23), built by a later slice: a "Delete account" Button with
        kind="danger" and testID "account-delete", which says what will be deleted before it asks to confirm.
        Sign out above shows how to end the session: useAccountActions().signOut().
      */}
    </View>
  );
}
