import practices from "../../store/data-practices.json";

// The outside services turtl asks permission for, read from store/data-practices.json so the permission screen, the
// privacy policy and the audit name the same services and say the same things. Pure: no Convex imports, so the app's
// example data and the tests load it as it is.

/** Every outside service the backend can send an owner's data to and that needs their yes in accounts mode. */
export type Outbound = "openai" | "supermemory" | "capy" | "keiki" | "anthropic" | "google";

export type AskedService = {
  id: string;
  name: string;
  does: string;
  receives: string[];
  policy: string;
  hosts: string[];
  /** Changes when the service's name or what it receives changes, so the owner is asked again. */
  version: string;
};

/** What an account agreed to: the services and the version of each that was on the screen. */
export type Agreement = {
  answer: "allowed" | "declined";
  services: { id: string; version: string }[];
  listVersion: string;
  withdrawnAt?: number;
};

// FNV-1a, 32 bits: a short, stable fingerprint that the app and the backend compute the same way.
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

type Practice = {
  id: string;
  name: string;
  inPrivacyPolicy: boolean;
  needsPermission: boolean;
  does: string;
  receives: string[];
  hosts: string[];
  policy?: string;
};

const services: Practice[] = practices.services;

export const ASKED: AskedService[] = services
  .filter((service) => service.needsPermission)
  .map((service) => ({
    id: service.id,
    name: service.name,
    does: service.does,
    receives: [...service.receives],
    policy: service.policy ?? "",
    hosts: [...service.hosts],
    version: fingerprint(JSON.stringify([service.id, service.name, service.receives])),
  }));

/** One version for the whole list: a new service, a removed one, or a change in what one receives asks again. */
export const LIST_VERSION = fingerprint(ASKED.map((service) => `${service.id}:${service.version}`).join("|"));

/** Services turtl uses without asking, because it cannot run without them. Named on the screen for completeness. */
export const ALSO_USED = services
  .filter((service) => !service.needsPermission && service.inPrivacyPolicy)
  .map((service) => ({ id: service.id, name: service.name, does: service.does }));

// Model providers the council can call that the list does not name. Nobody was asked about them, so in accounts mode
// nothing reaches them until data-practices.json lists them (and then the owner is asked again).
const UNLISTED: Record<string, { name: string; hosts: string[] }> = {
  anthropic: { name: "Anthropic", hosts: ["api.anthropic.com"] },
  google: { name: "Google", hosts: ["generativelanguage.googleapis.com"] },
};

/** Calls that spend model money, counted against the account's monthly limit. */
export const MODEL_SERVICES: readonly Outbound[] = ["openai", "anthropic", "google"];

export function serviceName(id: string): string {
  return ASKED.find((service) => service.id === id)?.name ?? UNLISTED[id]?.name ?? id;
}

/** The service a host belongs to, or null for a host no gated service names (GitHub, a stand-in server). */
export function serviceOfHost(host: string): string | null {
  const lower = host.toLowerCase();
  const owns = (hosts: string[]) => hosts.some((known) => lower === known || lower.endsWith(`.${known}`));
  return ASKED.find((service) => owns(service.hosts))?.id ?? Object.entries(UNLISTED).find(([, service]) => owns(service.hosts))?.[0] ?? null;
}

// The reasons are clauses, without a capital or a full stop, because each feature already says "No model answered: …"
// or "turtl can't answer right now: …" in front of them. They say what happened and what the owner can do.
export const refusal = {
  notAsked: (name: string) => `turtl has not asked you about ${name}, so nothing was sent to it`,
  unanswered: (name: string) => `you have not said yet whether turtl may send anything to ${name}, so nothing was sent (you can allow it in Settings)`,
  declined: (name: string) => `you chose not to let turtl send anything to ${name}, so nothing was sent (you can allow it in Settings)`,
  withdrawn: (name: string) => `you took back turtl's permission to send anything to ${name}, so nothing was sent (you can allow it again in Settings)`,
  added: (name: string) => `turtl added ${name} to its list after you answered, so nothing was sent to it until you read the list again in Settings`,
  changed: (name: string) => `what turtl sends to ${name} changed after you agreed, so nothing was sent until you read it again in Settings`,
  noOwner: (name: string) => `turtl could not tell whose project this is, so nothing was sent to ${name}`,
};

/** Whether an account's latest answer lets turtl send to this service now. */
export function permissionFor(agreement: Agreement | null, service: string): { ok: true } | { ok: false; reason: string } {
  const name = serviceName(service);
  const asked = ASKED.find((entry) => entry.id === service);
  if (!asked) return { ok: false, reason: refusal.notAsked(name) };
  if (!agreement) return { ok: false, reason: refusal.unanswered(name) };
  if (agreement.withdrawnAt !== undefined) return { ok: false, reason: refusal.withdrawn(name) };
  if (agreement.answer === "declined") return { ok: false, reason: refusal.declined(name) };
  const agreed = agreement.services.find((entry) => entry.id === service);
  if (!agreed) return { ok: false, reason: refusal.added(name) };
  if (agreed.version !== asked.version) return { ok: false, reason: refusal.changed(name) };
  return { ok: true };
}

export type Standing = {
  answer: "none" | "allowed" | "declined" | "withdrawn";
  /** The ids of the services turtl may send to now. */
  allowed: string[];
  /** True when the screen should be shown: never answered, or the list changed since. */
  needsAnswer: boolean;
};

export function standingOf(agreement: Agreement | null): Standing {
  if (!agreement) return { answer: "none", allowed: [], needsAnswer: true };
  const answer = agreement.withdrawnAt !== undefined ? "withdrawn" : agreement.answer;
  return {
    answer,
    allowed: ASKED.filter((service) => permissionFor(agreement, service.id).ok).map((service) => service.id),
    needsAnswer: agreement.listVersion !== LIST_VERSION,
  };
}
