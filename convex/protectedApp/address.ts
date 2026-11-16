import { localBackend } from "../demoSettings";

// Where turtl may send a request for an account's project (AUTH_REQUIRED=true).
//
// A project's live address must be https, name a public host (no IP literal, no loopback, private or link-local name)
// and hold no user name or password. Every request for the project, a check or an action, must be on that address's
// origin. The single-owner demo applies none of this: its one app is the operator's, and on a local backend it is
// http://127.0.0.1.
//
// Only names are checked: turtl cannot see what a name resolves to, so a public name pointed at a private address is
// not caught here.

declare const process: { env: Record<string, string | undefined> };

type Problem = "invalid" | "credentials" | "not_https" | "ip_literal" | "private";

const LOCAL_NAMES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/**
 * WATCHED_APP_ALLOW_LOOPBACK=true lets a backend that itself runs on this machine watch apps on 127.0.0.1 or localhost
 * over http, for stand-in servers in tests. Any other backend ignores it.
 */
export function loopbackAllowed(): boolean {
  return process.env.WATCHED_APP_ALLOW_LOOPBACK === "true" && localBackend();
}

function problemOf(text: string, allowLoopback: boolean): { problem: Problem } | { url: URL } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { problem: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "invalid" };
  if (url.username || url.password) return { problem: "credentials" };
  // The URL parser has already turned 2130706433, 0x7f.1 and 127.1 into 127.0.0.1.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (allowLoopback && LOOPBACK.includes(host)) return { url };
  if (url.protocol !== "https:") return { problem: "not_https" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return { problem: "ip_literal" };
  if (host === "localhost" || !host.includes(".") || LOCAL_NAMES.some((suffix) => host.endsWith(suffix))) return { problem: "private" };
  return { url };
}

const LIVE_ADDRESS: Record<Problem, string> = {
  invalid: "The live app address must be a full address, like https://example.com.",
  credentials: "The live app address must not contain a user name or password.",
  not_https: "The live app address must start with https://, so what turtl sends your app is always encrypted.",
  ip_literal: "The live app address must be a name, like app.example.com, not a numeric IP address.",
  private: "The live app address must be a public address on the internet, not a name inside a private network.",
};

/** Why turtl will not use this as a project's live address, as a sentence, or null when it will. */
export function liveAddressProblem(text: string, allowLoopback = loopbackAllowed()): string | null {
  const found = problemOf(text, allowLoopback);
  return "problem" in found ? LIVE_ADDRESS[found.problem] : null;
}

/** The origin of a usable live address, or null. */
export function liveOrigin(text: string, allowLoopback = loopbackAllowed()): string | null {
  const found = problemOf(text, allowLoopback);
  return "url" in found ? found.url.origin : null;
}

// Fragments, because callers write them into sentences such as "Not sent: <reason>." or "Not registered: <reason>.".
const REQUEST: Record<Problem, string> = {
  invalid: "the address is not a full web address, so turtl sent nothing",
  credentials: "the address holds a user name or password, so turtl sent nothing",
  not_https: "turtl sends requests for this project only over https, so it sent nothing",
  ip_literal: "turtl does not send requests to a numeric IP address, so it sent nothing",
  private: "turtl does not send requests to a name inside a private network, so it sent nothing",
};

/** Why turtl will not send this request for a project whose live origin is `origin`, as a fragment, or null. */
export function requestRefusal(text: string, origin: string, allowLoopback = loopbackAllowed()): string | null {
  const found = problemOf(text, allowLoopback);
  if ("problem" in found) return REQUEST[found.problem];
  if (found.url.origin !== origin) return `turtl sends this project's requests only to its own address, ${origin}, and this one is on ${found.url.origin}, so it sent nothing`;
  return null;
}
