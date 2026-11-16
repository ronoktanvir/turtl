// The app's view of Connect GitHub, in the shapes convex/github/connect.ts returns.

export type GithubConnection = {
  installationId: number;
  /** The GitHub account (a person or an organization) the installation is on. */
  accountLogin: string;
  /** The GitHub user who connected it. */
  githubLogin: string;
  status: "active" | "suspended";
  /** "all": the installation is on the person's own account. "chosen": the repositories they could reach in an organization. */
  scope: "all" | "chosen";
  /** The installation's settings on GitHub, where the owner chooses its repositories. */
  settingsUrl: string;
};

export type GithubStatus = {
  /** Whether this backend can connect GitHub at all. When false, Add project is the typed address it always was. */
  configured: boolean;
  /** Whether accounts are on (AUTH_REQUIRED on the backend). */
  accounts: boolean;
  signedIn: boolean;
  connections: GithubConnection[];
};

export type GithubRepository = { fullName: string; private?: boolean; installationId: number; accountLogin: string };

export type GithubDisconnect = {
  ok: boolean;
  disconnected: number;
  failed: { installationId: number; message: string }[];
  /** Installations turtl stopped using for this account but left installed, because they are not this person's to remove. */
  stillInstalled?: { installationId: number; accountLogin: string; message: string }[];
};

/** Repositories GitHub listed that turtl left out of the picker, each with a sentence saying why. */
export type GithubLeftOut = { fullName: string; message: string };

export type GithubRefresh = { ok: boolean; problems: string[]; leftOut?: GithubLeftOut[] };

/** What GitHub's last redirect said, in the github= parameter of the address that opened Add project. */
export type GithubReturn = "connected" | "cancelled" | "failed" | "none" | "requested";
