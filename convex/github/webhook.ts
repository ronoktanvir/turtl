import { installationOf, record, repositoriesOf, type Installation, type Repository } from "./shapes";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export type Delivery = {
  event: "installation" | "installation_repositories";
  action: string;
  installation: Installation;
  // The status the delivery sets, or null when it only changes which repositories are covered.
  status: "active" | "suspended" | "deleted" | null;
  added: Repository[];
  removed: string[];
};

const LIFECYCLE: Record<string, "active" | "suspended" | "deleted"> = {
  created: "active",
  new_permissions_accepted: "active",
  unsuspend: "active",
  suspend: "suspended",
  deleted: "deleted",
};

// GitHub signs the raw body with the webhook secret (HMAC-SHA256) and sends "sha256=<hex>". The comparison
// reads all 32 bytes whatever they hold, so its timing says nothing about where a forgery went wrong.
export async function signatureMatches(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  const sent = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!secret || !sent) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected[index] ^ parseInt(sent.slice(index * 2, index * 2 + 2), 16);
  }
  return difference === 0;
}

export const bodyDigest = async (body: Uint8Array<ArrayBuffer>) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));

// Turns a verified delivery into the change it asks for. Only the two installation events are read; every other
// event and action is unsupported and changes nothing.
export function readDelivery(event: string, text: string): { ok: true; value: Delivery } | { ok: false; code: "UNSUPPORTED_EVENT" | "INVALID_PAYLOAD" } {
  if (event !== "installation" && event !== "installation_repositories") return { ok: false, code: "UNSUPPORTED_EVENT" };
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(text));
  } catch {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  const action = payload?.action;
  const read = installationOf(payload?.installation);
  if (!payload || typeof action !== "string" || !read) return { ok: false, code: "INVALID_PAYLOAD" };
  const { suspended: _suspended, ...installation } = read;
  if (event === "installation") {
    const status = Object.hasOwn(LIFECYCLE, action) ? LIFECYCLE[action] : null;
    if (!status) return { ok: false, code: "UNSUPPORTED_EVENT" };
    const added = status === "active" ? repositoriesOf(payload.repositories ?? []) : [];
    return added ? { ok: true, value: { event, action, installation, status, added, removed: [] } } : { ok: false, code: "INVALID_PAYLOAD" };
  }
  if (action !== "added" && action !== "removed") return { ok: false, code: "UNSUPPORTED_EVENT" };
  const added = repositoriesOf(payload.repositories_added ?? []);
  const removed = repositoriesOf(payload.repositories_removed ?? []);
  return added && removed
    ? { ok: true, value: { event, action, installation, status: null, added, removed: removed.map((repository) => repository.fullName) } }
    : { ok: false, code: "INVALID_PAYLOAD" };
}
