import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction, type ActionCtx } from "../_generated/server";
import { accessEnforced } from "../access";
import { exchangeCode, listUserInstallations, listUserRepositories, readUser, revokeUserToken, REPOSITORIES_PER_PAGE, type UserInstallation } from "./api";
import { authorizeUrl, CALLBACK_PATH, connectConfig, SETUP_PATH, webhookSecret, type ConnectConfig } from "./config";
import { MAX_LEFT_OUT, MAX_LINK_REPOSITORIES, MAX_LINKS } from "./links";
import { randomSecret, sha256 } from "./secrets";
import type { GithubUser, PersonRepository, Repository } from "./shapes";
import { bodyDigest, readDelivery, signatureMatches } from "./webhook";

export { CALLBACK_PATH, SETUP_PATH } from "./config";
export const WEBHOOK_PATH = "/github/webhook";
const MAX_BODY_BYTES = 5_000_000;
const MAX_REPOSITORIES = 2000;
// What one connection reads of a person's GitHub: at most 1,000 installations and 1,000 repositories in each.
const MAX_PAGES = 10;

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

// ---------------------------------------------------------------------------------------------- Connect GitHub

// The pages a person sees in the browser between GitHub and turtl. Plain text, no script, and no address of this
// page passed on to another site.
const SECURITY = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" };
const page = (status: number, heading: string, text: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>turtl</title></head>` +
      `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5"><h1 style="font-size: 1.4rem">${heading}</h1><p>${text}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY } },
  );
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, ...SECURITY } });
const backTo = (returnTo: string, params: Record<string, string>) => redirect(`${returnTo}?${new URLSearchParams(params)}`);

const installed = () => page(200, "Go back to turtl", "turtl's GitHub App was installed or changed on GitHub. Go back to turtl. If turtl does not show your repositories, tap Connect GitHub there again.");
const linkExpired = () => page(400, "This link has expired", "It was already used, or it is more than 15 minutes old. Go back to turtl and tap Connect GitHub again. Nothing was connected.");
const notSetUp = () => page(503, "Connecting GitHub is not set up", "This turtl backend cannot connect GitHub yet. Nothing was connected.");

// GET /github/setup: where GitHub sends a person after they install or change the app. The installation id GitHub
// puts in this address is not read, because anyone can type one. With the state of an attempt that is still waiting,
// the person is sent to authorize turtl, which is how GitHub confirms who they are and what they can reach.
export const setup = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const connect = connectConfig();
  const state = url.searchParams.get("state");
  const attempt = connect.ok && state ? await ctx.runQuery(internal.github.connect.waiting, { stateHash: await sha256(state) }) : null;
  if (!connect.ok || !state || !attempt) return installed();
  // GitHub asked an organization's owner to approve the app; nothing is installed yet.
  if (url.searchParams.get("setup_action") === "request") return backTo(attempt.returnTo, { github: "requested" });
  return redirect(await authorizeUrl(connect, state, attempt.codeVerifier));
});

type Confirmed = { user: GithubUser; installations: { installation: UserInstallation; repositories: PersonRepository[]; own: boolean }[] };

async function everyPage<T>(read: (page: number) => Promise<{ ok: true; body: T[] } | { ok: false; message: string }>): Promise<{ ok: true; body: T[] } | { ok: false; message: string }> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed = await read(page);
    if (!listed.ok) return listed;
    all.push(...listed.body);
    if (listed.body.length < REPOSITORIES_PER_PAGE) break;
  }
  return { ok: true, body: all };
}

// Asks GitHub, as the person who came back, who they are and what of turtl's app they can reach. The user token is
// used for these reads only, never stored, and revoked at the end whatever happened.
async function confirmPerson(connect: Extract<ConnectConfig, { ok: true }>, code: string, codeVerifier: string): Promise<{ ok: true; body: Confirmed } | { ok: false; message: string }> {
  const exchanged = await exchangeCode({ clientId: connect.clientId, clientSecret: connect.clientSecret, code, redirectUri: connect.site + CALLBACK_PATH, codeVerifier });
  if (!exchanged.ok) return exchanged;
  const token = exchanged.body;
  try {
    const user = await readUser(token);
    if (!user.ok) return user;
    const listed = await everyPage((page) => listUserInstallations(token, page));
    if (!listed.ok) return listed;
    const installations: Confirmed["installations"] = [];
    for (const installation of listed.body.filter((candidate) => !candidate.suspended).slice(0, MAX_LINKS)) {
      const repositories = await everyPage((page) => listUserRepositories(token, installation.installationId, page));
      if (!repositories.ok) return repositories;
      // An installation on the person's own account covers only repositories they own, so all of them are theirs.
      // Anywhere else (an organization) GitHub lists what they can reach, reading included, with their permissions in
      // each; linkOf keeps what they can change.
      const own = installation.accountType === "User" && installation.accountId === user.body.id;
      installations.push({ installation, repositories: repositories.body, own });
    }
    return { ok: true, body: { user: user.body, installations } };
  } finally {
    await revokeUserToken({ clientId: connect.clientId, clientSecret: connect.clientSecret, token });
  }
}

async function recordConfirmed(ctx: ActionCtx, confirmed: Confirmed) {
  for (const { installation, repositories } of confirmed.installations) {
    const { suspended: _suspended, accountId: _accountId, ...fields } = installation;
    const covered: Repository[] = repositories.map(({ canPush: _canPush, ...repository }) => repository);
    await ctx.runMutation(internal.github.installations.record, { installation: fields, status: "active", repositories: covered, seenAt: Date.now() });
  }
}

// What one installation links for the person. On their own account: everything it covers, as before. Anywhere else,
// with accounts on, only the repositories GitHub says they can change (push, maintain or admin), at most
// MAX_LINK_REPOSITORIES, because turtl's app can change every repository it covers; the rest are remembered as left
// out, with why. In the single-owner demo, everything GitHub listed, as before.
function linkOf({ installation, repositories, own }: Confirmed["installations"][number]) {
  const { installationId } = installation;
  if (own) return { installationId };
  if (!accessEnforced()) return { installationId, repositories: repositories.map((repository) => repository.fullName) };
  const changeable = repositories.filter((repository) => repository.canPush);
  const leftOut = [
    ...repositories.filter((repository) => !repository.canPush).map((repository) => ({ fullName: repository.fullName, why: "read_only" as const })),
    ...changeable.slice(MAX_LINK_REPOSITORIES).map((repository) => ({ fullName: repository.fullName, why: "too_many" as const })),
  ];
  return { installationId, repositories: changeable.slice(0, MAX_LINK_REPOSITORIES).map((repository) => repository.fullName), checked: true, leftOut: leftOut.slice(0, MAX_LEFT_OUT) };
}

// GET /github/callback: GitHub's answer to the authorization. The state is used once; the person is sent back to
// turtl with a ticket that only the account that started can use.
export const callback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const connect = connectConfig();
  if (!connect.ok) return notSetUp();
  const state = url.searchParams.get("state");
  const claimed = state ? await ctx.runMutation(internal.github.connect.claim, { stateHash: await sha256(state) }) : null;
  if (!claimed) return linkExpired();
  const stop = async (result: "cancelled" | "failed" | "none") => {
    await ctx.runMutation(internal.github.connect.fail, { attemptId: claimed.attemptId });
    return backTo(claimed.returnTo, { github: result });
  };
  const code = url.searchParams.get("code");
  if (!code) return await stop("cancelled");
  const confirmed = await confirmPerson(connect, code, claimed.codeVerifier);
  if (!confirmed.ok) return await stop("failed");
  if (confirmed.body.installations.length === 0) return await stop("none");
  await recordConfirmed(ctx, confirmed.body);
  const ticket = randomSecret();
  const accepted: boolean = await ctx.runMutation(internal.github.connect.confirm, {
    attemptId: claimed.attemptId,
    ticketHash: await sha256(ticket),
    githubUserId: confirmed.body.user.id,
    githubLogin: confirmed.body.user.login,
    installations: confirmed.body.installations.map(linkOf),
  });
  return accepted ? backTo(claimed.returnTo, { github: "connected", ticket }) : await stop("failed");
});

export function registerGithubRoutes(http: HttpRouter) {
  http.route({ path: WEBHOOK_PATH, method: "POST", handler: receiveWebhook });
  http.route({ path: SETUP_PATH, method: "GET", handler: setup });
  http.route({ path: CALLBACK_PATH, method: "GET", handler: callback });
}
