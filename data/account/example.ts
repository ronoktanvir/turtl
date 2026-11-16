import type { Account, AccountActions } from "./types";

// Example builds have no accounts: the Login screen's buttons are the demo's controls and nobody is signed in.

const demo: Account = { status: "demo", mode: undefined, viewer: null };
const nothing = async () => null;
const actions: AccountActions = { logIn: nothing, signUp: nothing, apple: nothing, github: nothing, requestReset: nothing, resetPassword: nothing, signOut: nothing, deleteAccount: nothing };

export function useAccount(): Account {
  return demo;
}

export function useAccountActions(): AccountActions {
  return actions;
}
