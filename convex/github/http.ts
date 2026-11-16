import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { webhookSecret } from "./config";
import { bodyDigest, readDelivery, signatureMatches } from "./webhook";

export const WEBHOOK_PATH = "/github/webhook";
export const SETUP_PATH = "/github/setup";
const MAX_BODY_BYTES = 5_000_000;
const MAX_REPOSITORIES = 2000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const refuse = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

// POST /github/webhook: GitHub's deliveries for turtl's GitHub App. Nothing is read from a body until its
// signature matches, and nothing is stored for a delivery that is refused.
export const receiveWebhook = httpAction(async (ctx, request) => {
  const secret = webhookSecret();
  if (!secret) return refuse(503, "WEBHOOK_NOT_CONFIGURED", "GITHUB_APP_WEBHOOK_SECRET is not set on this deployment.");
  const tooLarge = () => refuse(413, "TOO_LARGE", `The delivery is larger than ${MAX_BODY_BYTES} bytes.`);
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) return tooLarge();
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return tooLarge();
  if (!(await signatureMatches(secret, body, request.headers.get("X-Hub-Signature-256")))) {
    return refuse(401, "INVALID_SIGNATURE", "The delivery's signature does not match.");
  }
  const event = request.headers.get("X-GitHub-Event");
  const deliveryId = request.headers.get("X-GitHub-Delivery");
  if (!event || !deliveryId) return refuse(400, "MISSING_HEADERS", "Expected X-GitHub-Event and X-GitHub-Delivery.");
  if (event === "ping") return json({ ok: true, outcome: "pong" });
  const read = readDelivery(event, new TextDecoder().decode(body));
  if (!read.ok) {
    return read.code === "UNSUPPORTED_EVENT" ? json({ ok: true, outcome: "ignored" }) : refuse(400, read.code, "The delivery's payload is not one turtl can read.");
  }
  const oversized = read.value.added.length > MAX_REPOSITORIES;
  const outcome: "applied" | "duplicate" | "ignored" = await ctx.runMutation(internal.github.installations.receive, {
    deliveryId,
    bodyDigest: await bodyDigest(body),
    ...read.value,
    added: oversized ? [] : read.value.added,
    resync: oversized,
  });
  return json({ ok: true, outcome });
});

export function registerGithubRoutes(http: HttpRouter) {
  http.route({ path: WEBHOOK_PATH, method: "POST", handler: receiveWebhook });
  // GitHub sends a person here after they install or change the app. Until the Connect GitHub flow exists this
  // page only says so: an installation id in this address proves nothing and nothing is read from it.
  http.route({
    path: SETUP_PATH,
    method: "GET",
    handler: httpAction(async () =>
      new Response("turtl's GitHub App is installed. You can close this page and go back to turtl.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      }),
    ),
  });
}
