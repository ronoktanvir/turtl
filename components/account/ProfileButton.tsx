import { useState } from "react";
import { Pressable } from "react-native";
import { useAccount } from "../../data/account";
import { Button, Sheet } from "../ui";
import AccountSection from "./AccountSection";
import ProfilePicture from "./ProfilePicture";

/** Home's profile picture. Signed in, it opens the account sheet, so Sign out is reachable before there is a
 * project (and its gear sheet) to open. Without accounts it is the demo's photo, as before. */
export default function ProfileButton() {
  const { status } = useAccount();
  const [open, setOpen] = useState(false);
  if (status !== "signedIn") return <ProfilePicture />;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Your account" testID="home-account" hitSlop={4}>
        <ProfilePicture />
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title="Account" testID="account-sheet">
        <AccountSection heading={false} />
        <Button label="Done" onPress={() => setOpen(false)} testID="account-sheet-done" />
      </Sheet>
    </>
  );
}
