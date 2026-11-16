// What an owner entrusts to turtl, as the app sees it: whether each secret is set and when, never the secret.
// The shapes convex/secrets/project.ts and convex/secrets/account.ts return.

export type ControlTokenStatus = {
  /** Accounts on (AUTH_REQUIRED on the backend). Off, the single-owner demo uses the backend's own token. */
  accounts: boolean;
  set: boolean;
  setAt?: number;
  /** The one address turtl sends it to: the project's live origin. */
  sendsTo?: string;
  /** Why the monitor is not running this project's checks, or runs only some of them. */
  notWatched?: string;
  /** A practice app's token: turtl made it and keeps it, and it cannot be replaced or removed. */
  managed?: boolean;
};

export type CodingAgentStatus = {
  accounts: boolean;
  signedIn: boolean;
  set: boolean;
  setAt?: number;
};
