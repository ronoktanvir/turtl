// Who is signed in, as the app sees it. Read it with useAccount() from data/account.
//
// status:
// - "demo": no accounts. Example data, or a backend with AUTH_REQUIRED unset in a development build. Every screen
//   opens and the Login screen's buttons go straight to Home, as before accounts existed.
// - "checking": not known yet: the backend's mode is loading, or a saved session is being confirmed.
// - "accountsOff": a store build pointed at a backend with accounts switched off. The app refuses to run.
// - "signedOut" / "signedIn": accounts are on, and the backend has confirmed which.

export type AccountStatus = "demo" | "checking" | "accountsOff" | "signedOut" | "signedIn";

export type SignInMethod = "password" | "apple" | "github";

export type AccountMode = { accounts: boolean; github: boolean; passwordReset: boolean };

export type Viewer = {
  id: string; // the account id every record is filed under
  name: string | null;
  email: string | null;
  picture: string | null; // https only
  methods: SignInMethod[];
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
  signOut(): Promise<string | null>; // runs every onSignOut listener, ends the session on the server, forgets it here
  deleteAccount(): Promise<string | null>; // asks the backend to delete the account, then signs out to Login with a notice
};
