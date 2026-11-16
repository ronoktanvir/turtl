import { localBackend } from "../demoSettings";

// Where turtl may send a request for an account's project (AUTH_REQUIRED=true).
//
// A project's live address must be https, name a public host (no IP literal, no loopback, private or link-local name)
// on the standard https port, and hold no user name or password. Every request for the project, a check or an action,
// must be on that address's origin. The single-owner demo applies none of this: its one app is the operator's, and on a
// local backend it is http://127.0.0.1.
//
// The port (second review, "worth a second look"): a live app is the address its customers use, which is the standard
// port; an address with another is a development or staging server. Allowing any port would let an account have turtl
// connect to any port of any public host and report back whether it answered, and how fast.
//
// Only names are checked: turtl cannot see what a name resolves to, so a public name pointed at a private address is
// not caught here.
//
// Not turtl's own addresses (third review, "worth a second look"): this deployment's site and API (CONVEX_SITE_URL,
// CONVEX_CLOUD_URL, and CUSTOM_AUTH_SITE_URL when the site has a custom domain) serve turtl's own routes, so a project
// may not use them, and no request for a project goes to them, whatever path or query its turtl.json names. The one
// exception is a practice project, whose address turtl itself sets to /practice/<project id> on its own site
// (convex/practice; an owner cannot set or change it): its requests may go under that path, and nowhere else there.

declare const process: { env: Record<string, string | undefined> };

type Problem = "invalid" | "credentials" | "not_https" | "ip_literal" | "private" | "port" | "own";

const LOCAL_NAMES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/**
 * WATCHED_APP_ALLOW_LOOPBACK=true lets a backend that itself runs on this machine watch apps on 127.0.0.1 or localhost
 * over http, for stand-in servers in tests. Any other backend ignores it.
 */
export function loopbackAllowed(): boolean {
  return process.env.WATCHED_APP_ALLOW_LOOPBACK === "true" && localBackend();
}

/** A host as the network reads it: lower case, without the dot that may end a fully qualified name, so
 * "app.example.com." and "app.example.com" are one host. */
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.+$/, "");

/** An origin with its host as the network reads it, so the same origin spelled with a trailing dot compares equal
 * (review finding 25). The scheme and port still count: a stand-in app on another port of this machine is not turtl. */
const originOf = (url: URL) => `${url.protocol}//${hostOf(url)}${url.port ? ":" + url.port : ""}`;

/** This deployment's own origins: its site, its API, and its site's custom domain. */
function ownOrigins(): string[] {
  return [process.env.CONVEX_SITE_URL, process.env.CONVEX_CLOUD_URL, process.env.CUSTOM_AUTH_SITE_URL].flatMap((text) => {
    try {
      return text ? [originOf(new URL(text))] : [];
    } catch {
      return [];
    }
  });
}

/** Whether a URL on turtl's own site is under the practice project's own path (the parser has already folded "..",
 * so a path cannot climb out of it). */
const underPractice = (url: URL, practiceId: string | undefined) =>
  !!practiceId && (url.pathname === `/practice/${practiceId}` || url.pathname.startsWith(`/practice/${practiceId}/`));

function problemOf(text: string, allowLoopback: boolean, practiceId?: string): { problem: Problem } | { url: URL } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { problem: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "invalid" };
  if (url.username || url.password) return { problem: "credentials" };
  if (ownOrigins().includes(originOf(url)) && !underPractice(url, practiceId)) return { problem: "own" };
  // The URL parser has already turned 2130706433, 0x7f.1 and 127.1 into 127.0.0.1.
  const host = hostOf(url);
  if (allowLoopback && LOOPBACK.includes(host)) return { url };
  if (url.protocol !== "https:") return { problem: "not_https" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return { problem: "ip_literal" };
  if (host === "localhost" || !host.includes(".") || LOCAL_NAMES.some((suffix) => host.endsWith(suffix))) return { problem: "private" };
  // The parser leaves port empty for https's own (443, written or not).
  if (url.port !== "") return { problem: "port" };
  return { url };
}

const LIVE_ADDRESS: Record<Problem, string> = {
  invalid: "The live app address must be a full address, like https://example.com.",
  credentials: "The live app address must not contain a user name or password.",
  not_https: "The live app address must start with https://, so what turtl sends your app is always encrypted.",
  ip_literal: "The live app address must be a name, like app.example.com, not a numeric IP address.",
  private: "The live app address must be a public address on the internet, not a name inside a private network.",
  port: "The live app address must be the one your customers use, with no port number, like https://app.example.com.",
  own: "The live app address must be your app's own address, not turtl's.",
};

/** Why turtl will not use this as a project's live address, as a sentence, or null when it will. `practiceId` names
 * a practice project, whose own path on turtl's site is allowed. */
export function liveAddressProblem(text: string, allowLoopback = loopbackAllowed(), practiceId?: string): string | null {
  const found = problemOf(text, allowLoopback, practiceId);
  return "problem" in found ? LIVE_ADDRESS[found.problem] : null;
}

/** The origin of a usable live address, or null. */
export function liveOrigin(text: string, allowLoopback = loopbackAllowed(), practiceId?: string): string | null {
  const found = problemOf(text, allowLoopback, practiceId);
  return "url" in found ? found.url.origin : null;
}

// Fragments, because callers write them into sentences such as "Not sent: <reason>." or "Not registered: <reason>.".
const REQUEST: Record<Problem, string> = {
  invalid: "the address is not a full web address, so turtl sent nothing",
  credentials: "the address holds a user name or password, so turtl sent nothing",
  not_https: "turtl sends requests for this project only over https, so it sent nothing",
  ip_literal: "turtl does not send requests to a numeric IP address, so it sent nothing",
  private: "turtl does not send requests to a name inside a private network, so it sent nothing",
  port: "turtl sends requests for this project only to the standard https port, so it sent nothing",
  own: "turtl does not send a project's requests to turtl's own addresses, so it sent nothing",
};

/** Why turtl will not send this request for a project whose live origin is `origin`, as a fragment, or null.
 * `practiceId` names a practice project, whose requests may go under its own path on turtl's site. */
export function requestRefusal(text: string, origin: string, allowLoopback = loopbackAllowed(), practiceId?: string): string | null {
  const found = problemOf(text, allowLoopback, practiceId);
  if ("problem" in found) return REQUEST[found.problem];
  if (found.url.origin !== origin) return `turtl sends this project's requests only to its own address, ${origin}, and this one is on ${found.url.origin}, so it sent nothing`;
  return null;
}
