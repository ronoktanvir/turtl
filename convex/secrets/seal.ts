// Seals and opens what an owner entrusts to turtl (a project's control token, an account's coding agent key) with
// AES-GCM and the key in SECRETS_ENCRYPTION_KEY. No imports, so tests load this file directly.
//
// Only actions call it: they have the platform's cryptographic randomness for the IV, which queries and mutations
// do not, and a secret is opened only inside the action that sends it.

declare const process: { env: Record<string, string | undefined> };

export const KEY_VARIABLE = "SECRETS_ENCRYPTION_KEY";
const FORMAT = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const chars = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
  return bytes;
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export type SealingKey = { key: CryptoKey; keyId: string };
export type Sealed = { sealed: string; keyId: string };

/**
 * The key in SECRETS_ENCRYPTION_KEY: 32 random bytes written in base64, made with `openssl rand -base64 32`.
 * Null when it is missing or is not 32 bytes. keyId names the key without revealing it (the start of its SHA-256), so a
 * row sealed with an earlier key is recognised as such instead of failing to open for no stated reason.
 */
export async function sealingKey(text: string | undefined = process.env.SECRETS_ENCRYPTION_KEY): Promise<SealingKey | null> {
  if (!text?.trim()) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(text.trim());
  } catch {
    return null;
  }
  if (raw.length !== KEY_BYTES) return null;
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const keyId = hex(await crypto.subtle.digest("SHA-256", raw)).slice(0, 16);
  return { key, keyId };
}

/**
 * Seals a secret. `context` names exactly what it is and whose (see contextOf in store.ts) and is bound into the
 * seal as additional data, so a sealed value copied onto another project's or account's row does not open there.
 */
export async function seal(plaintext: string, context: string, { key, keyId }: SealingKey): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, encoder.encode(plaintext));
  return { sealed: `${FORMAT}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`, keyId };
}

/** Opens a sealed secret, or null when it was sealed with another key or for another context, or was altered. */
export async function open(sealed: string, context: string, { key }: SealingKey): Promise<string | null> {
  const [format, iv, body] = sealed.split(".");
  if (format !== FORMAT || !iv || !body) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(context) }, key, fromBase64(body));
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
