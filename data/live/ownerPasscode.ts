import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api } from "../../convex/_generated/api";
import { errorMessage, requireLiveClient } from "./client";

const storageKey = `turtl.owner-passcode.${process.env.EXPO_PUBLIC_CONVEX_URL ?? "local"}`;
const nativeStorageKey = storageKey.replace(/[^a-zA-Z0-9._-]/g, "_");
const refusal = "That owner passcode is incorrect. Try again.";

export async function getStoredOwnerPasscode(): Promise<string | undefined> {
  const value = Platform.OS === "web" ? localStorage.getItem(storageKey) : await SecureStore.getItemAsync(nativeStorageKey);
  return value ?? undefined;
}

export async function storeOwnerPasscode(value?: string): Promise<void> {
  if (Platform.OS === "web") {
    if (value === undefined) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, value);
  } else if (value === undefined) await SecureStore.deleteItemAsync(nativeStorageKey);
  else await SecureStore.setItemAsync(nativeStorageKey, value);
}

type Prompt = { error?: string; busy: boolean };
let prompt: Prompt | null = null;
let pending: { work: (passcode: string) => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null;
const listeners = new Set<() => void>();

function updatePrompt(value: Prompt | null) {
  prompt = value;
  listeners.forEach((listener) => listener());
}

export function useOwnerPasscodePrompt() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => prompt,
    () => null,
  );
}

export function cancelOwnerPasscode() {
  if (prompt?.busy) return;
  pending?.reject(new Error("The owner decision was cancelled. Nothing was changed."));
  pending = null;
  updatePrompt(null);
}

export async function submitOwnerPasscode(passcode: string) {
  if (!pending || prompt?.busy) return;
  const request = pending;
  updatePrompt({ busy: true });
  try {
    await storeOwnerPasscode(passcode);
  } catch {
    updatePrompt({ busy: false, error: "This device could not save the passcode. Check that device storage is available." });
    return;
  }
  try {
    const result = await request.work(passcode);
    pending = null;
    updatePrompt(null);
    request.resolve(result);
  } catch (error) {
    if (errorMessage(error) === refusal) {
      await storeOwnerPasscode().catch(() => {});
      updatePrompt({ busy: false, error: refusal });
      return;
    }
    pending = null;
    updatePrompt(null);
    request.reject(error);
  }
}

export async function withOwnerPasscode<T>(work: (passcode?: string) => Promise<T>): Promise<T> {
  const status = await requireLiveClient().query(api.ownerPasscode.status, {});
  const passcode = status.configured ? await getStoredOwnerPasscode().catch(() => undefined) : undefined;
  let error: string | undefined;
  if (!status.configured || passcode !== undefined) {
    try { return await work(passcode); }
    catch (caught) {
      if (errorMessage(caught) !== refusal) throw caught;
      error = refusal;
      await storeOwnerPasscode();
    }
  }
  if (pending) throw new Error("Finish the current owner decision first.");
  return new Promise<T>((resolve, reject) => {
    pending = { work, resolve: (value) => resolve(value as T), reject };
    updatePrompt({ busy: false, error });
  });
}
