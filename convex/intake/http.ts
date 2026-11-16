import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { MAX_BODY_BYTES, readSubmission } from "./rules";

export const INTAKE_PATH = "/intake/report";

// Customer report forms post from other origins, so this endpoint answers CORS; it carries no credentials.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });

// POST /intake/report: { key, text, kind?: "bug" | "request", contact?, reporterId?, reportId? }.
// The key is an app's public intake key. The text is stored as it was written and triaged later.
export function registerIntakeRoutes(http: HttpRouter) {
  http.route({ path: INTAKE_PATH, method: "OPTIONS", handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })) });
  http.route({
    path: INTAKE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const length = Number(request.headers.get("Content-Length") ?? "0");
      if (length > MAX_BODY_BYTES) {
        return json({ ok: false, error: { code: "TOO_LARGE", message: `The report is larger than ${MAX_BODY_BYTES} bytes.` } }, 413);
      }
      const read = readSubmission(await request.text());
      if (!read.ok) return json({ ok: false, error: { code: read.code, message: read.message } }, read.status);
      const { hint, ...submission } = read.value;
      const result = await ctx.runMutation(internal.intake.records.receive, { ...submission, ...(hint && { hint }) });
      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.code, message: result.message } },
          result.status,
          result.retryAfterSeconds ? { "Retry-After": String(result.retryAfterSeconds) } : {},
        );
      }
      return json({ ok: true, received: true }, 202);
    }),
  });
}
