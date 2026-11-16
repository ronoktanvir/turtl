import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { CODE_VALID_HOURS, normalizeEmail } from "../../convex/auth/rules";

// The address this device last asked to reset, kept on this device only (the iOS Keychain on a phone, the browser's
// storage in the preview), for as long as a reset code works. A reset link carries only the code (finding 21: a link
// someone forwards from their own account must not choose whose password is set), so this is how the screen a link
// opens knows whose reset was asked for here. Nothing in the link can change it; without it the person types their
// address. The backend takes the code only for the address it was sent to.

const KEY = "turtl.resetAddress";
const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const LIFE_MS = CODE_VALID_HOURS * 3_600_000;

const store = {
  get: async (): Promise<string | null> => {
    if (Platform.OS !== "web") return await SecureStore.getItemAsync(KEY, options);
    try {
      return globalThis.localStorage?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
  },
  set: async (value: string): Promise<void> => {
    if (Platform.OS !== "web") return await SecureStore.setItemAsync(KEY, value, options);
    try {
      globalThis.localStorage?.setItem(KEY, value);
    } catch {
      // Storage refused (a private window): the person types their address instead.
    }
  },
  remove: async (): Promise<void> => {
    if (Platform.OS !== "web") return await SecureStore.deleteItemAsync(KEY, options);
    try {
      globalThis.localStorage?.removeItem(KEY);
    } catch {
      // Nothing to forget.
    }
  },
};

/** After "Email me a code": the address this device asked to reset. */
export async function rememberResetAddress(email: string): Promise<void> {
  await store.set(JSON.stringify({ email, at: Date.now() })).catch(() => {});
}

/** The address this device asked to reset within a code's life, or null. */
export async function recentResetAddress(now = Date.now()): Promise<string | null> {
  try {
    const saved = JSON.parse((await store.get()) ?? "null") as { email?: unknown; at?: unknown } | null;
    if (!saved || typeof saved.at !== "number" || now - saved.at > LIFE_MS || saved.at > now) return null;
    return normalizeEmail(saved.email);
  } catch {
    return null;
  }
}

/** After a reset that worked. */
export async function forgetResetAddress(): Promise<void> {
  await store.remove().catch(() => {});
}
