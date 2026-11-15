import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { revision } from "./catalog";
import { STAGED_TIMEOUT_MS } from "./provider";

const http = httpRouter();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function authorize(request: Request) {
  const secret = process.env.PROTECTED_APP_CONTROL_SECRET;
  if (!secret) return json({ error: { code: "CONTROL_NOT_CONFIGURED", message: "Control secret is not configured." } }, 503);
  if (request.headers.get("Authorization") !== `Bearer ${secret}`) return json({ error: { code: "UNAUTHORIZED", message: "A valid control bearer token is required." } }, 401);
  return null;
}

http.route({ path: "/health", method: "GET", handler: httpAction(async () => json({ ok: true, service: "protected-booking", timestamp: Date.now() })) });
http.route({ path: "/revision", method: "GET", handler: httpAction(async () => json({ revision: revision(), environment: "protected-app" })) });

for (const path of ["/flags", "/staged-failure"] as const) {
  http.route({ path, method: "GET", handler: httpAction(async (ctx, request) => {
    const denied = authorize(request);
    if (denied) return denied;
    const state = await ctx.runQuery(internal.state.read, {});
    return json(path === "/flags" ? { recommendationsEnabled: state.recommendationsEnabled, updatedAt: state.updatedAt } : { staged: true, providerTimeout: state.providerTimeout, timeoutMs: STAGED_TIMEOUT_MS, updatedAt: state.updatedAt });
  }) });
  http.route({ path, method: "POST", handler: httpAction(async (ctx, request) => {
    const denied = authorize(request);
    if (denied) return denied;
    const field = path === "/flags" ? "recommendationsEnabled" : "providerTimeout";
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON", message: "Expected a JSON object." } }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !(field in body) || typeof (body as Record<string, unknown>)[field] !== "boolean") {
      return json({ error: { code: "INVALID_BODY", message: `Expected exactly one boolean field: ${field}.` } }, 400);
    }
    const value = (body as Record<string, boolean>)[field];
    const state = await ctx.runMutation(internal.state.set, path === "/flags" ? { recommendationsEnabled: value } : { providerTimeout: value });
    return json(path === "/flags" ? { recommendationsEnabled: state.recommendationsEnabled, updatedAt: state.updatedAt } : { staged: true, providerTimeout: state.providerTimeout, timeoutMs: STAGED_TIMEOUT_MS, updatedAt: state.updatedAt });
  }) });
}

http.route({ path: "/journey-check", method: "POST", handler: httpAction(async (ctx, request) => {
  const denied = authorize(request);
  if (denied) return denied;
  const result = await ctx.runAction(internal.checks.journey, {});
  return json(result, result.verdict === "passed" ? 200 : 503);
}) });

http.route({ path: "/errors", method: "GET", handler: httpAction(async (ctx, request) => {
  const denied = authorize(request);
  if (denied) return denied;
  const until = Date.now();
  return json(await ctx.runQuery(internal.records.impact, { since: until - 15 * 60 * 1000, until }));
}) });

export default http;
