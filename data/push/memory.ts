import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// What this phone remembers about notifications, per backend: the token it registered (so it can refresh or remove
// it), and whether the owner has already been offered notifications once.

export type PushMemory = { token?: string; offered?: boolean };

const storageKey = `turtl.push.${process.env.EXPO_PUBLIC_CONVEX_URL ?? "local"}`;
const nativeStorageKey = storageKey.replace(/[^a-zA-Z0-9._-]/g, "_");

export async function readPushMemory(): Promise<PushMemory> {
  try {
    const raw = Platform.OS === "web" ? globalThis.localStorage?.getItem(storageKey) : await SecureStore.getItemAsync(nativeStorageKey);
    const value = raw ? (JSON.parse(raw) as PushMemory) : {};
    return {
      ...(typeof value.token === "string" ? { token: value.token } : {}),
      ...(value.offered === true ? { offered: true } : {}),
    };
  } catch {
    return {};
  }
}

export async function writePushMemory(value: PushMemory): Promise<void> {
  const raw = JSON.stringify(value);
  try {
    if (Platform.OS === "web") globalThis.localStorage?.setItem(storageKey, raw);
    else await SecureStore.setItemAsync(nativeStorageKey, raw);
  } catch {
    // Forgetting only means the offer may show again or the next launch registers afresh.
  }
}
