import { isLiveData } from "../source";
import * as example from "./example";
import * as live from "./live";

// Accounts and sign-in for the app. useAccount() says who is signed in (see ./types.ts for the statuses);
// useAccountActions() signs in and out; onSignOut() lets any part of the app clear what it keeps for the person
// before the session ends. useSignedOutNotice() is the one line Login shows after an account was deleted.

export type { Account, AccountActions, AccountMode, AccountStatus, Confirmation, SignInMethod, Viewer } from "./types";
export const useAccount = isLiveData ? live.useAccount : example.useAccount;
export const useAccountActions = isLiveData ? live.useAccountActions : example.useAccountActions;
export const useConfirmation = isLiveData ? live.useConfirmation : example.useConfirmation;
export const onSignOut = live.onSignOut;
export { rememberLinkedCode, setSignedOutNotice, takeLinkedCode, useSignedOutNotice } from "./notice";
