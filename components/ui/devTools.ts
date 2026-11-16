import { useAccount } from "../../data/account";
import { devToolsShown } from "../../data/source";
import { devToolsOn } from ".";

// Whether this build shows the Dev pill and the "Live cases" link. A development build pointed at a backend with
// accounts on (AUTH_REQUIRED=true) hides both: that backend refuses every dev tool, so they would only fail.
export function useDevToolsOn(): boolean {
  const { mode } = useAccount();
  return devToolsShown(devToolsOn, mode);
}
