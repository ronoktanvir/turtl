import { useSyncExternalStore } from "react";

// One line the Login screen shows after the app signed someone out on purpose, such as "Your account is being
// deleted." It lives in memory only: it is gone when the app restarts, and Login clears it when it leaves.

export const words = {
  deleting: "Your account is being deleted. turtl is removing everything it kept for it.",
  deleteFailed: "turtl couldn't delete your account just now. Check your connection and try again.",
} as const;

let notice: string | null = null;
const listeners = new Set<() => void>();

export function setSignedOutNotice(text: string | null) {
  notice = text;
  listeners.forEach((notify) => notify());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => notice;

export function useSignedOutNotice(): string | null {
  return useSyncExternalStore(subscribe, read, read);
}
