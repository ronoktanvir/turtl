import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

// Accounts and sign-in for the app. useAccount() says who is signed in (see ./types.ts for the statuses);
// useAccountActions() signs in and out; onSignOut() lets any part of the app clear what it keeps for the person
// before the session ends.

export type { Account, AccountActions, AccountMode, AccountStatus, SignInMethod, Viewer } from "./types";
export const useAccount = isLiveData ? live.useAccount : example.useAccount;
export const useAccountActions = isLiveData ? live.useAccountActions : example.useAccountActions;
export const onSignOut = live.onSignOut;
