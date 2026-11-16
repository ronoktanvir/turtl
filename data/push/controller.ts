import type { PushMemory } from "./memory";
import type { PushBackend, PushDevice, PushPermission, PushStatus } from "./types";

// Push notifications on this phone: what the settings row shows, and turning them on, off, fresh and away.
// Nothing here runs unless the row is shown, and nothing asks the phone for permission unless the owner taps.

export const PUSH_EXPLAINED = "turtl sends a notification naming the project when a case needs your decision or a fix you allowed has run, and never includes what customers wrote, error messages or code.";
export const PUSH_DECLINED = "Notifications stay off. Everything else works, and you will see every case when you open turtl.";
export const PUSH_TOKEN_FAILED = "This phone could not set up notifications. Check your connection and try again.";
export const PUSH_FAILED = "turtl could not change notifications for this phone. Check your connection and try again.";

export type PushKind = "hidden" | "loading" | "unsupported" | "signed_out" | "blocked" | "off" | "on";

export type PushState = { memory: PushMemory | null; permission: PushPermission | null; busy: boolean; message: string | null };

/** Which state the notifications row is in. Hidden unless this is a store build or the backend runs accounts mode. */
export function pushKind(input: {
  live: boolean;
  storeBuild: boolean;
  supported: boolean;
  status: PushStatus | null | undefined;
  state: Pick<PushState, "memory" | "permission">;
}): PushKind {
  const { live, storeBuild, supported, status, state } = input;
  if (!live || status === null) return "hidden";
  if (status === undefined) return storeBuild ? "loading" : "hidden";
  if (!storeBuild && !status.accountsMode) return "hidden";
  if (!supported) return "unsupported";
  if (!status.signedIn) return "signed_out";
  if (state.memory === null || state.permission === null) return "loading";
  if (state.permission === "denied") return "blocked";
  return status.registered && state.permission === "granted" && state.memory.token ? "on" : "off";
}

/** The one-time offer shows when notifications are off, the phone has never been asked, and turtl never offered. */
export function offerDue(kind: PushKind, state: Pick<PushState, "memory" | "permission">): boolean {
  return kind === "off" && state.permission === "undetermined" && state.memory !== null && !state.memory.offered;
}

export type PushController = ReturnType<typeof createPushController>;

export function createPushController(deps: {
  device: () => PushDevice;
  backend: PushBackend;
  readMemory: () => Promise<PushMemory>;
  writeMemory: (value: PushMemory) => Promise<void>;
}) {
  let state: PushState = { memory: null, permission: null, busy: false, message: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PushState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  let loading: Promise<void> | null = null;
  let freshened = false;

  async function remember(patch: Partial<PushMemory>) {
    const next: PushMemory = { ...(state.memory ?? (await deps.readMemory())), ...patch };
    if (next.token === undefined) delete next.token;
    set({ memory: next });
    await deps.writeMemory(next);
  }

  async function phoneToken(): Promise<string> {
    try {
      return await deps.device().token();
    } catch {
      throw new Error(PUSH_TOKEN_FAILED);
    }
  }

  const platformOf = () => {
    const platform = deps.device().platform;
    return platform === "android" ? "android" : "ios";
  };

  /** Reads what this phone remembers and its permission. Asks nothing. */
  function load(): Promise<void> {
    return (loading ??= (async () => {
      const memory = await deps.readMemory();
      const device = deps.device();
      let permission: PushPermission = "denied";
      if (device.supported) {
        try { permission = await device.permission(); } catch { permission = "denied"; }
      }
      set({ memory, permission });
    })());
  }

  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    /** The owner tapped Turn on: ask the phone, then register its token. Declining changes nothing else. */
    async turnOn(): Promise<void> {
      if (state.busy) return;
      set({ busy: true, message: null });
      try {
        const device = deps.device();
        await device.setup();
        let permission = await device.permission();
        if (permission === "undetermined") permission = await device.request();
        set({ permission });
        await remember({ offered: true });
        if (permission !== "granted") { set({ message: PUSH_DECLINED }); return; }
        const token = await phoneToken();
        await deps.backend.register(token, platformOf());
        await remember({ token });
      } catch (error) {
        set({ message: error instanceof Error && error.message ? error.message : PUSH_FAILED });
      } finally {
        set({ busy: false });
      }
    },
    /** The owner tapped Turn off: this phone stops receiving. The phone's own permission is left as it is. */
    async turnOff(): Promise<void> {
      if (state.busy) return;
      const token = state.memory?.token;
      set({ busy: true, message: null });
      try {
        if (token) await deps.backend.remove(token);
        await remember({ token: undefined });
      } catch (error) {
        set({ message: error instanceof Error && error.message ? error.message : PUSH_FAILED });
      } finally {
        set({ busy: false });
      }
    },
    /** "Not now" on the offer. */
    async dismissOffer(): Promise<void> {
      await remember({ offered: true });
    },
    async openSettings(): Promise<void> {
      try { await deps.device().openSettings(); } catch { /* nothing to do */ }
    },
    /**
     * Once per launch, and whenever the phone's token changes: re-files a phone that receives notifications, so a
     * changed token replaces the old one, and removes it when the owner turned notifications off in the phone's settings.
     */
    async keepFresh(force = false): Promise<void> {
      if ((freshened && !force) || state.busy) return;
      freshened = true;
      await load();
      const stored = state.memory?.token;
      const device = deps.device();
      if (!stored || !device.supported) return;
      try {
        const permission = await device.permission();
        set({ permission });
        if (permission !== "granted") {
          await deps.backend.remove(stored);
          await remember({ token: undefined });
          return;
        }
        await device.setup();
        const token = await device.token();
        await deps.backend.refresh(token, platformOf(), token !== stored ? stored : undefined);
        if (token !== stored) await remember({ token });
      } catch {
        // Best effort; the next launch tries again.
      }
    },
    /** For sign-out, before the session ends: this phone stops receiving this account's notifications. Never throws. */
    async remove(): Promise<void> {
      try {
        const memory = state.memory ?? (await deps.readMemory());
        if (!memory.token) return;
        try { await deps.backend.remove(memory.token); } catch { /* the token still leaves this phone's memory */ }
        await remember({ token: undefined });
      } catch {
        // Never blocks a sign-out.
      }
    },
  };
}
