import { Linking, Platform } from "react-native";
import { caseIdFrom, type PushDevice, type PushPermission } from "./types";

// The phone's notification system through expo-notifications. The library is loaded on first use, so a build where
// notifications are off (the demo, the example build) never loads it.

type Notifications = typeof import("expo-notifications");
let loaded: Notifications | null = null;
const lib = (): Notifications => (loaded ??= require("expo-notifications") as Notifications);

let ready: Promise<void> | null = null;

function interpret(settings: Awaited<ReturnType<Notifications["getPermissionsAsync"]>>): PushPermission {
  const N = lib();
  const ios = settings.ios?.status;
  if (settings.granted || ios === N.IosAuthorizationStatus.PROVISIONAL || ios === N.IosAuthorizationStatus.EPHEMERAL) return "granted";
  return settings.status === "undetermined" && settings.canAskAgain ? "undetermined" : "denied";
}

const device: PushDevice = {
  supported: Platform.OS === "ios" || Platform.OS === "android",
  platform: Platform.OS === "android" ? "android" : "ios",
  setup: () => (ready ??= (async () => {
    const N = lib();
    // Shows a notification that arrives while turtl is open, the same as when it is closed.
    N.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    });
    // Android 13 and later ask for permission only once a channel exists.
    if (Platform.OS === "android") {
      await N.setNotificationChannelAsync("default", { name: "Cases that need you", importance: N.AndroidImportance.HIGH });
    }
  })().catch((error) => { ready = null; throw error; })),
  permission: async () => interpret(await lib().getPermissionsAsync()),
  request: async () => interpret(await lib().requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } })),
  token: async () => (await lib().getExpoPushTokenAsync()).data,
  onTokenChange: (listener) => {
    const subscription = lib().addPushTokenListener(() => listener());
    return () => subscription.remove();
  },
  onOpen: (listener) => {
    const N = lib();
    const handle = (response: import("expo-notifications").NotificationResponse | null) => {
      if (!response || response.actionIdentifier !== N.DEFAULT_ACTION_IDENTIFIER) return;
      const caseId = caseIdFrom(response.notification.request.content.data);
      N.clearLastNotificationResponse();
      if (caseId) listener(caseId);
    };
    handle(N.getLastNotificationResponse());
    const subscription = N.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  },
  openSettings: () => Linking.openSettings(),
};

export function pushDevice(): PushDevice {
  return device;
}
