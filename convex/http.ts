import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { revision } from "./bookingDemo/catalog";
import { STAGED_TIMEOUT_MS } from "./bookingDemo/provider";
import { registerIntakeRoutes } from "./intake/http";

declare const process: { env: Record<string, string | undefined> };

const http = httpRouter();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function authorize(request: Request) {
  const expected = process.env.PROTECTED_APP_CONTROL_SECRET_SHA256;
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return json({ error: { code: "CONTROL_NOT_CONFIGURED", message: "Control secret is not configured." } }, 503);
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let difference = 0;
  for (let index = 0; index < 32; index++) {
    difference |= digest[index] ^ parseInt(expected.slice(index * 2, index * 2 + 2), 16);
  }
  if (difference !== 0 || token.length === 0) return json({ error: { code: "UNAUTHORIZED", message: "A valid control bearer token is required." } }, 401);
  return null;
}

http.route({ path: "/booking-demo/health", method: "GET", handler: httpAction(async () => json({ ok: true, service: "protected-booking", timestamp: Date.now() })) });
http.route({ path: "/booking-demo/revision", method: "GET", handler: httpAction(async () => json({ revision: revision(), environment: "protected-app" })) });

for (const path of ["/booking-demo/flags", "/booking-demo/staged-failure"] as const) {
  http.route({ path, method: "GET", handler: httpAction(async (ctx, request) => {
    const denied = await authorize(request);
    if (denied) return denied;
    const state = await ctx.runQuery(internal.bookingDemo.state.read, {});
    return json(path === "/booking-demo/flags" ? { recommendationsEnabled: state.recommendationsEnabled, updatedAt: state.updatedAt } : { staged: true, providerTimeout: state.providerTimeout, bookingStoreFailure: state.bookingStoreFailure, timeoutMs: STAGED_TIMEOUT_MS, updatedAt: state.updatedAt });
  }) });
  http.route({ path, method: "POST", handler: httpAction(async (ctx, request) => {
    const denied = await authorize(request);
    if (denied) return denied;
    const fields = path === "/booking-demo/flags" ? ["recommendationsEnabled"] : ["providerTimeout", "bookingStoreFailure"];
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Expected a JSON object." } }, 400); }
    const field = body && typeof body === "object" ? Object.keys(body)[0] : undefined;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !field || !fields.includes(field) || typeof (body as Record<string, unknown>)[field] !== "boolean") {
      return json({ error: { code: "INVALID_BODY", message: `Expected exactly one boolean field: ${fields.join(" or ")}.` } }, 400);
    }
    const value = (body as Record<string, boolean>)[field];
    const state = await ctx.runMutation(internal.bookingDemo.state.set, field === "recommendationsEnabled" ? { recommendationsEnabled: value } : field === "providerTimeout" ? { providerTimeout: value } : { bookingStoreFailure: value });
    return json(path === "/booking-demo/flags" ? { recommendationsEnabled: state.recommendationsEnabled, updatedAt: state.updatedAt } : { staged: true, providerTimeout: state.providerTimeout, bookingStoreFailure: state.bookingStoreFailure, timeoutMs: STAGED_TIMEOUT_MS, updatedAt: state.updatedAt });
  }) });
}

http.route({ path: "/booking-demo/journey-check", method: "POST", handler: httpAction(async (ctx, request) => {
  const denied = await authorize(request);
  if (denied) return denied;
  const result = await ctx.runAction(internal.bookingDemo.checks.journey, {});
  return json(result, result.verdict === "passed" ? 200 : 503);
}) });

http.route({ path: "/booking-demo/errors", method: "GET", handler: httpAction(async (ctx, request) => {
  const denied = await authorize(request);
  if (denied) return denied;
  const until = Date.now();
  return json(await ctx.runQuery(internal.bookingDemo.records.impact, { since: until - 15 * 60 * 1000, until }));
}) });

registerIntakeRoutes(http);

export default http;
