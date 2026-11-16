// Who is signed in, as the app sees it. Read it with useAccount() from data/account.
//
// status:
// - "demo": no accounts. Example data, or a backend with AUTH_REQUIRED unset in a development build. Every screen
//   opens and the Login screen's buttons go straight to Home, as before accounts existed.
// - "checking": not known yet: the backend's mode is loading, or a saved session is being confirmed.
// - "accountsOff": a store build pointed at a backend with accounts switched off. The app refuses to run.
// - "signedOut" / "signedIn": accounts are on, and the backend has confirmed which.
// - "unconfirmed": signed in with a password, but the email address is not confirmed yet. The app shows only
//   Check your email (app/confirm-email.tsx) until it is.

export type AccountStatus = "demo" | "checking" | "accountsOff" | "signedOut" | "signedIn" | "unconfirmed";

export type SignInMethod = "password" | "apple" | "github";

export type AccountMode = { accounts: boolean; github: boolean; passwordReset: boolean };

export type Viewer = {
  id: string; // the account id every record is filed under
  name: string | null;
  email: string | null;
  picture: string | null; // https only
  methods: SignInMethod[];
  confirmed?: boolean; // false while a password account's email address is not confirmed; missing from an older backend
};

/** What Check your email shows (convex/auth/confirmation.ts status). Times are milliseconds since 1970. */
export type Confirmation = {
  email: string;
  lastSentAt: number | null;
  worksUntil: number | null;
  nextSendAt: number | null;
  removedAt: number;
};

export type Account = {
  status: AccountStatus;
  mode: AccountMode | undefined; // undefined while loading, and always in example builds
  viewer: Viewer | null | undefined; // undefined while loading
};

/** Each resolves to null when there is nothing to show (done, or cancelled), or to a sentence for the owner. */
export type AccountActions = {
  logIn(email: string, password: string): Promise<string | null>;
  signUp(email: string, password: string): Promise<string | null>;
  apple(): Promise<string | null>;
  github(): Promise<string | null>;
  requestReset(email: string): Promise<string | null>;
  resetPassword(email: string, code: string, newPassword: string): Promise<string | null>;
  confirmEmail(code: string): Promise<string | null>; // the code from the email; on success the gate opens Projects
  resendConfirmation(): Promise<{ sent: boolean; message: string }>; // another email, when the limits allow
  startOver(): Promise<string | null>; // throws this unconfirmed account away and signs out, to sign up with another address
  signOut(): Promise<string | null>; // runs every onSignOut listener, ends the session on the server, forgets it here
  deleteAccount(): Promise<string | null>; // asks the backend to delete the account, then signs out to Login with a notice
};
