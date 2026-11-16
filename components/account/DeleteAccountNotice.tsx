import { useEffect } from "react";
import { setSignedOutNotice, useSignedOutNotice } from "../../data/account";
import { T } from "../ui";

/** The one line Login shows after this phone deleted its account: the account is being deleted. It goes when Login
 * does (someone signs in) or the app restarts. Nothing in the demo or the example build, which never set it. */
export default function DeleteAccountNotice() {
  const notice = useSignedOutNotice();
  useEffect(() => () => setSignedOutNotice(null), []);
  if (!notice) return null;
  return (
    <T color="textMuted" accessibilityLiveRegion="polite" testID="login-notice" style={{ textAlign: "center" }}>
      {notice}
    </T>
  );
}
