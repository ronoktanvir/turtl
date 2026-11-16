import type { PushDevice } from "./types";

// The browser. expo-notifications does nothing on the web, so notifications are unsupported here and nothing is
// asked or registered. A preview or test page may install a stand-in before the app loads, as
// window.__turtlPushDevice, to show the phone's states in a browser. Phones use device.native.ts instead.

const unsupported: PushDevice = {
  supported: false,
  platform: "web",
  setup: async () => {},
  permission: async () => "denied",
  request: async () => "denied",
  token: async () => { throw new Error("Notifications work in the turtl app on a phone."); },
  onTokenChange: () => () => {},
  onOpen: () => () => {},
  openSettings: async () => {},
};

export function pushDevice(): PushDevice {
  const standIn = typeof window !== "undefined" ? (window as { __turtlPushDevice?: PushDevice }).__turtlPushDevice : undefined;
  return standIn ?? unsupported;
}
