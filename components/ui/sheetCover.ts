import { useSyncExternalStore, type ReactNode } from "react";

// A Sheet is a Modal, so it draws above everything in the root layout, including the "Can't reach turtl" screen
// shown while the backend is out of reach. The root layout hands that screen to open sheets through this slot, so
// an owner who tapped Approve as the network dropped sees why "Approving…" is not moving, not a frozen sheet.

let cover: ReactNode = null;
const listeners = new Set<() => void>();

/** What every open Sheet shows over itself. Pass null to clear it. */
export function setSheetCover(next: ReactNode) {
  cover = next;
  listeners.forEach((listener) => listener());
}

export function useSheetCover(): ReactNode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => cover,
    () => null,
  );
}
