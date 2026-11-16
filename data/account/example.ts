import type { Account, AccountActions, Confirmation } from "./types";

// Example builds have no accounts: the Login screen's buttons are the demo's controls and nobody is signed in.

const demo: Account = { status: "demo", mode: undefined, viewer: null };
const nothing = async () => null;
const actions: AccountActions = {
  logIn: nothing,
  signUp: nothing,
  apple: nothing,
  github: nothing,
  requestReset: nothing,
  resetPassword: nothing,
  confirmEmail: nothing,
  resendConfirmation: async () => ({ sent: false, message: "" }),
  startOver: nothing,
  signOut: nothing,
  deleteAccount: nothing,
};

export function useAccount(): Account {
  return demo;
}

export function useAccountActions(): AccountActions {
  return actions;
}

export function useConfirmation(): Confirmation | null {
  return null;
}
