// What an owner reads about their secrets. No imports, so tests and other modules share the exact sentences.

export const DEMO_KEEPS_CONTROL_TOKEN =
  "This turtl backend is the single-owner demo, which sends the control token set on the backend itself. Nothing was stored.";
export const DEMO_KEEPS_CODING_AGENT =
  "This turtl backend is the single-owner demo, which uses the coding agent key set on the backend itself. Nothing was stored.";
// The owner cannot set the backend's encryption key, so they read that turtl is not ready; the operator finds the
// setting's name in the backend's log (convex/secrets/seal.ts) and in convex/secrets/README.md.
export const NO_SEALING_KEY =
  "turtl cannot keep secrets on this backend yet, because its encryption is not set up. That is for turtl's operator to fix. Nothing was stored.";
export const NOT_A_CONTROL_TOKEN = "That does not look like a control token. Paste the whole token: at least 16 characters, with no spaces.";
/** A practice app's control token is turtl's own (convex/secrets/managed.ts). */
export const MANAGED_TOKEN = "turtl made your practice app's control token and keeps it itself, so it can't be replaced or removed.";
export const NOT_A_CODING_AGENT_KEY = "That does not look like a Capy API key. Paste the whole key: at least 16 characters, with no spaces.";

/** How to connect a coding agent, for every place that needs one. A sentence that ends with a full stop. */
export const CONNECT_CODING_AGENT = "Connect a coding agent first: in Settings (the gear), add your Capy API key under Coding agent.";

/** A secret is sent as an HTTP header, so it must be one line of printable characters with no spaces. */
export const sendable = (value: string) => /^[\x21-\x7E]{16,512}$/.test(value);
