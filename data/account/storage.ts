import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// Where the session lives between launches. On the phone: the iOS Keychain, through expo-secure-store, readable
// after the first unlock since boot (so work started by a notification can use it) and never copied to another
// device by a backup. In the browser preview: localStorage, which Convex Auth uses when given nothing.

type TokenStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const tokenStorage: TokenStorage | undefined =
  Platform.OS === "web"
    ? undefined
    : {
        getItem: (key) => SecureStore.getItemAsync(key, options),
        setItem: (key, value) => SecureStore.setItemAsync(key, value, options),
        removeItem: (key) => SecureStore.deleteItemAsync(key, options),
      };
