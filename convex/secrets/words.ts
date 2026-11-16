// What an owner reads about their secrets. No imports, so tests and other modules share the exact sentences.

export const DEMO_KEEPS_CONTROL_TOKEN =
  "This turtl backend is the single-owner demo, which sends the control token set on the backend itself. Nothing was stored.";
export const DEMO_KEEPS_CODING_AGENT =
  "This turtl backend is the single-owner demo, which uses the coding agent key set on the backend itself. Nothing was stored.";
export const NO_SEALING_KEY =
  "turtl cannot keep secrets on this backend yet, because its encryption key (SECRETS_ENCRYPTION_KEY) is not set. Nothing was stored.";
export const NOT_A_CONTROL_TOKEN = "That does not look like a control token. Paste the whole token: at least 16 characters, with no spaces.";
export const NOT_A_CODING_AGENT_KEY = "That does not look like a Capy API key. Paste the whole key: at least 16 characters, with no spaces.";

/** How to connect a coding agent, for every place that needs one. A sentence that ends with a full stop. */
export const CONNECT_CODING_AGENT = "Connect a coding agent first: in Settings (the gear), add your Capy API key under Coding agent.";

/** A secret is sent as an HTTP header, so it must be one line of printable characters with no spaces. */
export const sendable = (value: string) => /^[\x21-\x7E]{16,512}$/.test(value);
