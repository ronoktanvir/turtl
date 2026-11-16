const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// 32 random bytes, for a state, a ticket or a PKCE verifier. Called only from actions and HTTP actions, which have
// the platform's cryptographic randomness; queries and mutations do not make secrets.
export function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

// turtl stores a state or a ticket only as this hash, so a copy of the table cannot finish anyone's connection.
export async function sha256(text: string): Promise<string> {
  return Array.from(await digest(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// PKCE (S256): GitHub stores this with the authorization and gives the user token only to whoever has the verifier.
export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(await digest(verifier));
}
