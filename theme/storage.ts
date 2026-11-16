import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// Where the person's theme is kept between launches, in the storage the session already uses on each platform
// (data/account/storage.ts): the iOS Keychain through expo-secure-store on the phone, localStorage in the browser.
// Both are read synchronously, so the first frame is already in the chosen theme. Nothing stored means the default.

export type StoredMode = "dark" | "light";

const KEY = "turtl.theme";

type Store = { read(): string | null; write(value: string): void };

const web: Store = {
  read: () => (typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)),
  write: (value) => { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, value); },
};
const phone: Store = {
  read: () => SecureStore.getItem(KEY),
  write: (value) => SecureStore.setItem(KEY, value),
};

/** The kept choice, or null when the person never chose or the store cannot be read. */
export function readMode(store: Store = Platform.OS === "web" ? web : phone): StoredMode | null {
  try {
    const value = store.read();
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

/** Keeps the choice. A store that cannot be written leaves the choice for this session only. */
export function writeMode(mode: StoredMode, store: Store = Platform.OS === "web" ? web : phone): void {
  try {
    store.write(mode);
  } catch {
    // The theme still changes now; it is only not kept.
  }
}
