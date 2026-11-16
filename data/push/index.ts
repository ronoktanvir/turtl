import { useEffect, useSyncExternalStore } from "react";
import { onSignOut } from "../account";
import { isLiveData, isStoreBuild } from "../source";
import { createPushController, offerDue, pushKind, type PushKind } from "./controller";
import { pushDevice } from "./device";
import { exampleBackend } from "./example";
import { liveBackend } from "./live";
import { readPushMemory, writePushMemory } from "./memory";

export { PUSH_EXPLAINED } from "./controller";
export type { PushKind } from "./controller";

const backend = isLiveData ? liveBackend : exampleBackend;
const controller = createPushController({ device: pushDevice, backend, readMemory: readPushMemory, writeMemory: writePushMemory });

export type PushView = {
  kind: PushKind;
  /** True once, the first time notifications could be offered. */
  offer: boolean;
  busy: boolean;
  message: string | null;
  turnOn: () => Promise<void>;
  turnOff: () => Promise<void>;
  dismissOffer: () => Promise<void>;
  openSettings: () => Promise<void>;
};

/** The notifications state of this phone. Hidden in the demo and the example build. */
export function usePush(): PushView {
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  useEffect(() => { if (isLiveData) void controller.load(); }, []);
  const status = backend.useStatus(state.memory?.token, isLiveData && state.memory !== null);
  const kind = pushKind({ live: isLiveData, storeBuild: isStoreBuild, supported: pushDevice().supported, status, state });
  return {
    kind,
    offer: offerDue(kind, state),
    busy: state.busy,
    message: state.message,
    turnOn: controller.turnOn,
    turnOff: controller.turnOff,
    dismissOffer: controller.dismissOffer,
    openSettings: controller.openSettings,
  };
}

/** Keeps a registered phone's token current while notifications are on. */
export function useKeepPushFresh(active: boolean) {
  useEffect(() => {
    if (!active) return;
    void controller.keepFresh();
    return pushDevice().onTokenChange(() => void controller.keepFresh(true));
  }, [active]);
}

/** Calls back with the case id when the owner taps a notification. Only where live data could have sent one. */
export function useNotificationTaps(open: (caseId: string) => void) {
  useEffect(() => {
    const device = pushDevice();
    if (!isLiveData || !device.supported) return;
    return device.onOpen(open);
  }, [open]);
}

/**
 * For the sign-out flow: call before the session ends, while the account can still be identified. This phone stops
 * receiving the account's notifications. Never throws; it does nothing when the phone never registered.
 */
export function removePushRegistration(): Promise<void> {
  return isLiveData ? controller.remove() : Promise.resolve();
}

// Signing out runs this first (data/account/live.ts), so the old account's notifications stop reaching this phone and
// the next account to sign in here can register it. While the backend cannot be reached, sign-out waits and then stops.
if (isLiveData) onSignOut(removePushRegistration);
