export type PushPermission = "granted" | "denied" | "undetermined";
export type PushPlatform = "ios" | "android";

/** What the app needs from the phone's notification system. device.native.ts wraps expo-notifications; device.ts is the browser. */
export type PushDevice = {
  /** False where notifications cannot work (a browser). Nothing else is called then. */
  supported: boolean;
  platform: PushPlatform | "web";
  /** Prepares the phone before the first request (on Android, the channel notifications arrive in). Safe to call twice. */
  setup(): Promise<void>;
  permission(): Promise<PushPermission>;
  /** Shows the phone's own permission prompt when it still can, and returns the answer. */
  request(): Promise<PushPermission>;
  /** This phone's Expo push token. Throws when the phone or Expo cannot give one. */
  token(): Promise<string>;
  onTokenChange(listener: () => void): () => void;
  /** Calls back with the case id when the owner taps a notification, including the one that opened the app. */
  onOpen(listener: (caseId: string) => void): () => void;
  openSettings(): Promise<void>;
};

/** What the backend says about this phone (convex/push/devices.ts status). */
export type PushStatus = { accountsMode: boolean; signedIn: boolean; registered: boolean };

export type PushBackend = {
  /** undefined while loading; null when the backend cannot say (it has no convex/push yet). */
  useStatus(token: string | undefined, ready: boolean): PushStatus | null | undefined;
  register(token: string, platform: PushPlatform): Promise<void>;
  /** False when the backend no longer files this phone under the signed-in account; it then registered nothing. */
  refresh(token: string, platform: PushPlatform, previousToken?: string): Promise<boolean>;
  remove(token: string): Promise<void>;
};

const CASE_ID = /^[a-z0-9]{8,64}$/;
/** The case id a notification carries, or null when it carries none that could be one. */
export function caseIdFrom(data: unknown): string | null {
  const caseId = data && typeof data === "object" ? (data as { caseId?: unknown }).caseId : undefined;
  return typeof caseId === "string" && CASE_ID.test(caseId) ? caseId : null;
}
