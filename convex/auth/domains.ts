// Limits per email domain (security review, finding 19): one domain must not use up the room every other sign-up
// shares. Pure, so tests read it as it is. The counting is in convex/spend/ceilings.ts (sign-ups and confirmations)
// and convex/auth/codes.ts (emails).
//
// A domain may take a small share of each deployment-wide ceiling: OWN_DOMAIN_SHARE, at least MIN_PER_DOMAIN. That
// suits a company's or a person's own domain, and stops a script that makes every address at one domain it owns (a
// catch-all domain gives it endless real mailboxes). The large public providers below hold most real people's
// addresses, so the same share would lock out everyone who uses one; each of them may take LARGE_PROVIDER_SHARE
// instead. Making many real mailboxes at one of them costs a phone number or more each, so a script gains little there.
// Keep the list short and only here.

export const LARGE_PROVIDERS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
] as const;

/** The share of a deployment-wide ceiling one ordinary domain may take. */
export const OWN_DOMAIN_SHARE = 0.1;
/** The share one of the large public providers may take. */
export const LARGE_PROVIDER_SHARE = 0.5;
/** No domain is held below this, however small the ceiling. */
export const MIN_PER_DOMAIN = 2;

// Two-letter country domains where people register under a second level ("acme.co.uk"). Enough to keep one
// organisation's addresses together; a full public suffix list is not needed for a cap.
const SECOND_LEVELS = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ltd", "plc", "ne", "or", "go"]);

/**
 * The domain a cap counts against: the registrable part of the address's domain, so mail.acme.com, eu.acme.com and
 * acme.com are one. Takes a normalized address (convex/auth/rules.ts normalizeEmail).
 */
export function emailDomain(email: string): string {
  const labels = email.slice(email.lastIndexOf("@") + 1).split(".").filter(Boolean);
  const keep = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVELS.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export function isLargeProvider(domain: string): boolean {
  return (LARGE_PROVIDERS as readonly string[]).includes(domain);
}

/** What one domain may take of a deployment-wide ceiling. */
export function domainCap(ceiling: number, domain: string): number {
  const share = isLargeProvider(domain) ? LARGE_PROVIDER_SHARE : OWN_DOMAIN_SHARE;
  return Math.max(MIN_PER_DOMAIN, Math.floor(ceiling * share));
}

/** What a person reads when a domain's share, or the day's emails, are used up. Shown as written. */
export const domainRefusal = {
  signUpsThisHour: "turtl is making a lot of new accounts for addresses at this email domain right now. Try again in an hour, or sign up with Apple or GitHub.",
  signUpsToday: "turtl has made as many new accounts for addresses at this email domain as it makes in one day. Try again tomorrow, or sign up with Apple or GitHub.",
  confirmationsThisHour: "turtl is confirming a lot of accounts at this email domain right now, so it can't confirm yours this hour. Your code still works: try again in an hour.",
  confirmationsToday: "turtl has confirmed as many accounts at this email domain as it does in one day. Try again tomorrow, and ask for a new code if this one has stopped working.",
  emailsToday: "turtl has sent as many emails as it sends in one day, so it can't send one now. Try again tomorrow. A code turtl already sent you still works.",
  domainEmailsToday: "turtl has sent as many emails to addresses at this email domain as it sends in one day. Try again tomorrow. A code turtl already sent you still works.",
  signUpEmailsToday: "turtl has sent as many emails as it sends in one day, so it can't make a new account with an email address now. Try again tomorrow, or sign up with Apple or GitHub.",
  signUpDomainEmailsToday: "turtl has sent as many emails to addresses at this email domain as it sends in one day, so it can't make a new account for this address now. Try again tomorrow, or sign up with Apple or GitHub.",
};
