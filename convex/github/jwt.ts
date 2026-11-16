const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const segment = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// GitHub hands out the key as PKCS#1 ("BEGIN RSA PRIVATE KEY") and Web Crypto imports only PKCS#8, so a
// PKCS#1 key is wrapped in the PKCS#8 envelope for an RSA key. A PKCS#8 key ("BEGIN PRIVATE KEY") passes through.
function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, "\n"));
  if (!match) throw new Error("Not a PEM private key.");
  const key = Uint8Array.from(atob(match[2].replace(/\s+/g, "")), (character) => character.charCodeAt(0));
  if (!match[1]) return key;
  const body = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, ...derLength(key.length), ...key];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

export const UNREADABLE_KEY = "GITHUB_APP_PRIVATE_KEY is not a PEM private key that turtl can read.";

// The app's own credential: RS256, issued a minute ago against clock drift, good for nine minutes (GitHub allows ten).
// Null when the key cannot be read; the reason is never echoed, because it could hold part of the key.
export async function signAppJwt(appId: string, privateKey: string, now = Date.now()): Promise<string | null> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pkcs8(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return null;
  }
  const seconds = Math.floor(now / 1000);
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}
