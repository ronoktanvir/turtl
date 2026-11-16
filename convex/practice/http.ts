import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { httpAction, type ActionCtx } from "../_generated/server";
import { readScenario } from "../bookingDemo/journeyCore";
import { ENVIRONMENT } from "../protectedApp/client";
import type { PracticeJourney } from "./app";
import { PRACTICE_PREFIX, PRACTICE_REVISION, routeOf } from "./rules";

// Every practice app's routes, under /practice/<project id>/ on this deployment's site address: the booking demo's
// control contract (convex/http.ts), with each project's own switches and rows. turtl reaches them only as it reaches any
// owner's app, through call() in convex/protectedApp/client.ts with the project's own control token.
//
// Only health and revision answer without a token, as in the booking demo. Everything else, and every route that
// changes anything (a switch, or the test booking a journey check makes and deletes), answers only to the bearer token
// whose SHA-256 the project's practice row holds. A path that names no practice app is 404, token or not. There is no
// route for the failures themselves: only the owner breaks their practice app, from turtl.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const refuse = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of a token, in hex: what a practice row keeps instead of the token. */
export async function tokenHashOf(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

/** Whether a request carries the token whose hash is `expected`, compared in constant time. */
export async function carriesToken(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const digest = await tokenHashOf(token);
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= digest.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

const SWITCH_PATHS = { flags: "recommendationsEnabled", "backup-store": "backupStoreEnabled" } as const;
type SwitchPath = keyof typeof SWITCH_PATHS;
const isSwitch = (endpoint: string): endpoint is SwitchPath => Object.keys(SWITCH_PATHS).includes(endpoint);

async function serve(ctx: ActionCtx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = routeOf(url.pathname);
  const found: { appId: Id<"apps">; tokenHash: string } | null = route ? await ctx.runQuery(internal.practice.app.route, { appId: route.appId }) : null;
  if (!route || !found) return refuse(404, "NOT_FOUND", "No practice app answers at this address.");
  const { endpoint } = route;
  const method = request.method;

  if (method === "GET" && endpoint === "health") return json({ ok: true, service: "practice-booking", timestamp: Date.now() });
  if (method === "GET" && endpoint === "revision") return json({ revision: PRACTICE_REVISION, environment: ENVIRONMENT });
  const known = (method === "GET" && (isSwitch(endpoint) || endpoint === "errors")) || (method === "POST" && (isSwitch(endpoint) || endpoint === "journey-check"));
  if (!known) return refuse(404, "NOT_FOUND", "No practice app answers at this address.");
  if (!(await carriesToken(request, found.tokenHash))) return refuse(401, "UNAUTHORIZED", "A valid control bearer token is required.");

  if (endpoint === "errors") {
    // The practice app has no customers, so no customer booking has ever failed on it.
    const until = Date.now();
    return json({ window: { since: until - 15 * 60 * 1000, until, sampleLimit: 1000, truncated: false }, counts: { totalBookings: 0, failedBookings: 0, successfulBookings: 0, errorRate: 0 }, errors: [] });
  }
  if (endpoint === "journey-check") {
    const read = readScenario(url);
    if (!read.ok) return refuse(400, "UNKNOWN_SCENARIO", read.message);
    const result: PracticeJourney | null = await ctx.runAction(internal.practice.app.journey, { appId: found.appId, ...(read.scenario && { scenario: read.scenario }) });
    if (!result) return refuse(404, "NOT_FOUND", "No practice app answers at this address.");
    return json(result, result.verdict === "passed" ? 200 : 503);
  }
  if (!isSwitch(endpoint)) return refuse(404, "NOT_FOUND", "No practice app answers at this address.");
  const name = SWITCH_PATHS[endpoint];
  if (method === "GET") {
    const now = await ctx.runQuery(internal.practice.app.switches, { appId: found.appId });
    if (!now) return refuse(404, "NOT_FOUND", "No practice app answers at this address.");
    return json({ [name]: now[name], updatedAt: now.updatedAt });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "INVALID_JSON", "Expected a JSON object.");
  }
  const fields = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
  const value = fields.length === 1 && fields[0] === name ? (body as Record<string, unknown>)[name] : undefined;
  if (typeof value !== "boolean") return refuse(400, "INVALID_BODY", `Expected exactly one boolean field: ${name}.`);
  const set = await ctx.runMutation(internal.practice.app.setSwitch, { appId: found.appId, name, value });
  if (!set) return refuse(404, "NOT_FOUND", "No practice app answers at this address.");
  return json({ [name]: set.value, updatedAt: set.updatedAt });
}

export function registerPracticeRoutes(http: HttpRouter) {
  for (const method of ["GET", "POST"] as const) {
    http.route({ pathPrefix: PRACTICE_PREFIX, method, handler: httpAction(serve) });
  }
}
