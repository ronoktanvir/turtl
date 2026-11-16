import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { tokenStorage } from "../../data/account/storage";
import { isLiveData } from "../../data/source";

/** Gives the app its backend client, with sign-in attached to that same client on live data. Example builds keep the
 * plain provider their dev tools need. */
export default function AccountProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) {
  if (!isLiveData) return <ConvexProvider client={client}>{children}</ConvexProvider>;
  return (
    <ConvexAuthProvider client={client} storage={tokenStorage} shouldHandleCode={Platform.OS === "web"}>
      {children}
    </ConvexAuthProvider>
  );
}
