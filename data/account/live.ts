import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useMemo, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { api } from "../../convex/_generated/api";
import { words } from "../../convex/auth/rules";
import { liveClient } from "../live/client";
import { setSignedOutNotice, words as notices } from "./notice";
import { isStoreBuild } from "../source";
import { accountStatus, signInMessage } from "./status";
import type { Account, AccountActions, AccountMode } from "./types";

// Sign-in against the live backend, through Convex Auth's provider on the app's one client (liveClient). The
// provider stores the session (see ./storage.ts) and attaches it to every query and mutation that client makes.

// The backend's mode, watched once for the whole app. An older backend without users.mode is a backend without
// accounts.
const WITHOUT_ACCOUNTS: AccountMode = { accounts: false, github: false, passwordReset: false };
let mode: AccountMode | undefined;
let watching = false;
const modeListeners = new Set<() => void>();

function subscribeMode(listener: () => void) {
  modeListeners.add(listener);
  if (!watching && liveClient) {
    watching = true;
    const watch = liveClient.watchQuery(api.users.mode, {});
    const read = () => {
      let next: AccountMode | undefined;
      try {
        next = watch.localQueryResult();
      } catch {
        next = WITHOUT_ACCOUNTS;
      }
      if (next === undefined || JSON.stringify(next) === JSON.stringify(mode)) return;
      mode = next;
      modeListeners.forEach((notify) => notify());
    };
    watch.onUpdate(read);
    read();
  }
  return () => {
    modeListeners.delete(listener);
  };
}

const readMode = () => mode;
const useMode = () => useSyncExternalStore(subscribeMode, readMode, readMode);

export function useAccount(): Account {
  const current = useMode();
  const auth = useConvexAuth();
  const status = accountStatus({ live: true, storeBuild: isStoreBuild, mode: current, auth });
  const viewer = useQuery(api.users.viewer, status === "signedIn" ? {} : "skip");
  return { status, mode: current, viewer: status === "signedIn" ? viewer : null };
}

// Other parts of the app register here to clear what they keep for the signed-in person (a push token, a draft).
const signOutListeners = new Set<() => void | Promise<void>>();
export function onSignOut(listener: () => void | Promise<void>): () => void {
  signOutListeners.add(listener);
  return () => {
    signOutListeners.delete(listener);
  };
}

/** Whether the app's connection to the backend is up, waiting a few seconds for it if it is coming back. */
function connected(waitMs = 5000): Promise<boolean> {
  const client = liveClient;
  if (!client) return Promise.resolve(false);
  if (client.connectionState().isWebSocketConnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    timer = setTimeout(() => finish(false), waitMs);
    unsubscribe = client.subscribeToConnectionState((state) => {
      if (state.isWebSocketConnected) finish(true);
    });
    if (done) unsubscribe();
  });
}

const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Runs one call to the backend. Refuses at once when offline, says so when the connection drops while it waits,
 * and gives up with a plain message when it hangs. A call that was sent still finishes if the connection returns. */
async function attempt(work: () => Promise<unknown>, { interactive = false, timeoutMs = 20_000 } = {}): Promise<string | null> {
  const client = liveClient;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const done = (value: unknown) => (typeof value === "string" ? value : null);
  try {
    if (browserOffline() || !client || !(await connected())) return words.offline;
    // Apple's sheet and GitHub's page wait on the person, and the app may be in the background meanwhile.
    if (interactive) return done(await work());
    const stalled = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(client.connectionState().isWebSocketConnected && !browserOffline() ? words.slow : words.offline), timeoutMs);
      unsubscribe = client.subscribeToConnectionState((state) => {
        if (!state.isWebSocketConnected) resolve(words.offline);
      });
    });
    return await Promise.race([work().then(done), stalled]);
  } catch (error) {
    return signInMessage(error);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

type SignIn = ReturnType<typeof useAuthActions>["signIn"];

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signInWithApple(signIn: SignIn): Promise<string | null> {
  if (Platform.OS !== "ios" || !(await AppleAuthentication.isAvailableAsync())) return words.appleElsewhere;
  // The backend checks that Apple's token carries the hash of this nonce, and accepts each nonce once.
  const nonce = hex(Crypto.getRandomBytes(32));
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_REQUEST_CANCELED") return null;
    throw error;
  }
  if (!credential.identityToken) return words.appleRefused;
  const name = credential.fullName ? AppleAuthentication.formatFullName(credential.fullName).trim() : "";
  // Apple's one-time code lets the backend keep Apple's refresh token, so deleting the account can revoke it.
  const code: Record<string, string> = credential.authorizationCode ? { authorizationCode: credential.authorizationCode } : {};
  await signIn("apple", { identityToken: credential.identityToken, nonce, ...(name ? { name } : {}), ...code });
  return null;
}

async function signInWithGitHub(signIn: SignIn, current: AccountMode | undefined): Promise<string | null> {
  if (!current?.github) return words.githubOff;
  if (Platform.OS === "web") {
    // The browser leaves for GitHub and comes back to this address with a one-time code, which the provider redeems.
    await signIn("github", { redirectTo: window.location.origin + "/" });
    return null;
  }
  const redirectTo = Linking.createURL("/");
  const { redirect } = await signIn("github", { redirectTo });
  if (!redirect) return words.githubRefused;
  const result = await WebBrowser.openAuthSessionAsync(redirect.toString(), redirectTo);
  if (result.type !== "success") return null;
  const code = Linking.parse(result.url).queryParams?.code;
  if (typeof code !== "string" || !code) return words.githubRefused;
  await signIn("github", { code });
  return null;
}

export function useAccountActions(): AccountActions {
  const { signIn, signOut } = useAuthActions();
  const current = useMode();
  return useMemo<AccountActions>(
    () => ({
      logIn: (email, password) => attempt(() => signIn("password", { email: email.trim(), password, flow: "signIn" })),
      signUp: (email, password) => attempt(() => signIn("password", { email: email.trim(), password, flow: "signUp" })),
      requestReset: (email) => attempt(() => signIn("password", { email: email.trim(), flow: "reset" })),
      resetPassword: (email, code, newPassword) => attempt(() => signIn("password", { email: email.trim(), code: code.trim(), newPassword, flow: "reset-verification" })),
      apple: () => attempt(() => signInWithApple(signIn), { interactive: true }),
      github: () => attempt(() => signInWithGitHub(signIn, current), { interactive: true }),
      signOut: async () => {
        // Ending the session on the server needs the connection; signing out offline would leave it open there.
        if (browserOffline() || !(await connected())) return words.offline;
        await Promise.allSettled([...signOutListeners].map(async (listener) => await listener()));
        await signOut();
        return null;
      },
      deleteAccount: async () => {
        // The backend ends every session of the account as it accepts, so what follows only tidies up this phone.
        const refused = await attempt(async () => {
          await liveClient?.mutation(api.account.deletion.request, {});
        });
        if (refused) return refused === words.unknown ? notices.deleteFailed : refused;
        setSignedOutNotice(notices.deleting);
        await Promise.allSettled([...signOutListeners].map(async (listener) => await listener()));
        await signOut();
        return null;
      },
    }),
    [signIn, signOut, current],
  );
}
