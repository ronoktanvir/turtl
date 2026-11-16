import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";

const decode = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
const reply = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
};
const redirect = (response, location) => {
  response.writeHead(302, { Location: location });
  response.end();
};
const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

// A stand-in for the parts of GitHub that convex/github calls. It checks credentials the way GitHub documents them:
// an app JWT must be RS256, signed by the app's key, name the app as issuer, be issued in the past and expire within
// ten minutes; an installation token must be one this server minted and must not have expired; a user token must come
// from a code this server issued, exchanged once with the app's client secret and the PKCE verifier.
// It also plays the person's browser on github.com: the install page and the authorize page answer with the
// redirects GitHub sends, for whoever signIn() named. It is not GitHub: it proves turtl's side of the exchange and
// nothing about GitHub's.
export async function startGithubStub({
  appId,
  publicKey,
  slug = "turtl-on-call",
  permissions = {},
  events = [],
  tokenTtlMs = 3_600_000,
  port = 0,
  clientId = "Iv23-stub-client",
  clientSecret = "stub-client-secret",
  site = "http://turtl.test",
} = {}) {
  const key = createPublicKey(publicKey);
  const installations = new Map();
  const tokens = new Map();
  const users = new Map();
  const codes = new Map();
  const userTokens = new Map();
  const requests = [];
  const uninstalled = [];
  const revoked = [];
  let minted = 0;
  let failing = null;
  let browser = null;
  let nextInstall = null;
  let denying = false;

  const appCredential = (authorization) => {
    const [scheme, jwt = ""] = (authorization ?? "").split(" ");
    const parts = jwt.split(".");
    if (scheme !== "Bearer" || parts.length !== 3) return null;
    try {
      const header = decode(parts[0]);
      const claims = decode(parts[1]);
      const now = Math.floor(Date.now() / 1000);
      const signed = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
      const valid = signed && header.alg === "RS256" && claims.iss === String(appId) && claims.iat <= now && claims.exp > now && claims.exp - now <= 600;
      return valid ? { header, claims } : null;
    } catch {
      return null;
    }
  };
  const describe = ({ id, account, repository_selection, suspended_at }) => ({ id, account, repository_selection, suspended_at });
  const userId = (login) => {
    if (!users.has(login)) users.set(login, { id: 9_000_000 + users.size + 1, login });
    return users.get(login).id;
  };
  // The repositories a person can reach in an installation: all of them on their own account, and in an
  // organization what its members list gives them. Null when they cannot reach the installation at all.
  const reachable = (installation, login) => {
    if (installation.account.type === "User") return installation.account.login === login ? installation.repositories : null;
    const member = installation.members[login];
    if (member === undefined) return null;
    return member === "all" ? installation.repositories : installation.repositories.filter((repository) => member.includes(repository.full_name));
  };
  const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");
  const callbacks = [`${site}/api/auth/callback/github`, `${site}/github/callback`];

  const install = ({ id, login, type = "User", selection = "selected", suspended = false, repositories = [], members = {}, accountId }) => {
    const installation = {
      id,
      account: { login, type, id: accountId ?? userId(login) },
      repository_selection: selection,
      suspended_at: suspended ? new Date().toISOString() : null,
      members,
      repositories: repositories.map((repository, index) => {
        const fields = typeof repository === "string" ? { full_name: repository } : repository;
        return { id: id * 100_000 + index + 1, name: fields.full_name.split("/")[1], private: true, ...fields };
      }),
    };
    installations.set(id, installation);
    return installation;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://github.stub");
    const authorization = request.headers.authorization;
    const entry = { method: request.method, path: url.pathname, credential: "refused" };
    requests.push(entry);
    if (failing) return reply(response, failing, { message: "Server Error" });
    let match;

    // github.com, in the person's browser.
    if (request.method === "GET" && url.pathname === `/apps/${slug}/installations/new`) {
      entry.credential = "browser";
      if (!browser) return reply(response, 401, { message: "Sign in to GitHub first" });
      const choice = nextInstall;
      nextInstall = null;
      const params = new URLSearchParams();
      if (choice?.request) params.set("setup_action", "request");
      else if (choice?.existing) {
        params.set("installation_id", String(choice.existing));
        params.set("setup_action", "update");
      } else {
        const made = install({ id: 8000 + installations.size + uninstalled.length + 1, login: browser, ...choice });
        params.set("installation_id", String(made.id));
        params.set("setup_action", "install");
      }
      if (url.searchParams.has("state")) params.set("state", url.searchParams.get("state"));
      return redirect(response, `${site}/github/setup?${params}`);
    }
    if (request.method === "GET" && url.pathname === "/login/oauth/authorize") {
      entry.credential = "browser";
      const redirectUri = url.searchParams.get("redirect_uri");
      if (url.searchParams.get("client_id") !== clientId || !callbacks.includes(redirectUri)) return reply(response, 400, { message: "The redirect_uri is not associated with this application." });
      if (url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge")) return reply(response, 400, { message: "PKCE S256 expected" });
      if (!browser) return reply(response, 401, { message: "Sign in to GitHub first" });
      const state = url.searchParams.get("state");
      if (denying) return redirect(response, `${redirectUri}?${new URLSearchParams({ error: "access_denied", ...(state && { state }) })}`);
      const code = `stub-code-${codes.size + 1}`;
      codes.set(code, { login: browser, redirectUri, challenge: url.searchParams.get("code_challenge"), used: false, expiresAt: Date.now() + 600_000 });
      return redirect(response, `${redirectUri}?${new URLSearchParams({ code, ...(state && { state }) })}`);
    }
    if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const text = await readBody(request);
      const body = (request.headers["content-type"] ?? "").includes("json") ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
      if (body.client_id !== clientId || body.client_secret !== clientSecret) return reply(response, 200, { error: "incorrect_client_credentials" });
      const issued = codes.get(body.code);
      if (!issued || issued.used || issued.expiresAt < Date.now() || issued.redirectUri !== body.redirect_uri || s256(body.code_verifier ?? "") !== issued.challenge) {
        return reply(response, 200, { error: "bad_verification_code" });
      }
      issued.used = true;
      entry.credential = "client";
      const token = `ghu_stub_${userTokens.size + revoked.length + 1}`;
      userTokens.set(token, issued.login);
      return reply(response, 200, { access_token: token, token_type: "bearer", scope: "" });
    }
    if (request.method === "DELETE" && (match = /^\/applications\/([^/]+)\/token$/.exec(url.pathname))) {
      const body = JSON.parse((await readBody(request)) || "{}");
      if (decodeURIComponent(match[1]) !== clientId || authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`) return reply(response, 404, { message: "Not Found" });
      entry.credential = "client";
      if (!userTokens.delete(body.access_token)) return reply(response, 404, { message: "Not Found" });
      revoked.push(body.access_token);
      return reply(response, 204);
    }

    // As the person: a user token.
    const person = userTokens.get((authorization ?? "").replace(/^Bearer /, ""));
    if (person && request.method === "GET") {
      entry.credential = "user";
      if (url.pathname === "/user") return reply(response, 200, { id: userId(person), login: person });
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      if (url.pathname === "/user/installations") {
        const visible = [...installations.values()].filter((installation) => reachable(installation, person) !== null);
        return reply(response, 200, { total_count: visible.length, installations: visible.slice((page - 1) * perPage, page * perPage).map(describe) });
      }
      if ((match = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname))) {
        const installation = installations.get(Number(match[1]));
        const repositories = installation && reachable(installation, person);
        if (!repositories) return reply(response, 404, { message: "Not Found" });
        return reply(response, 200, { total_count: repositories.length, repository_selection: installation.repository_selection, repositories: repositories.slice((page - 1) * perPage, page * perPage) });
      }
    }

    if (request.method === "GET" && url.pathname === "/installation/repositories") {
      const token = tokens.get((authorization ?? "").replace(/^Bearer /, ""));
      const installation = token && token.expiresAt > Date.now() ? installations.get(token.installationId) : undefined;
      if (!installation || installation.suspended_at) return reply(response, 401, { message: "Bad credentials" });
      entry.credential = "installation";
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return reply(response, 200, {
        total_count: installation.repositories.length,
        repository_selection: installation.repository_selection,
        repositories: installation.repositories.slice((page - 1) * perPage, page * perPage),
      });
    }

    // As the app: a JWT.
    const app = appCredential(authorization);
    if (!app) return reply(response, 401, { message: "A JSON web token could not be decoded" });
    entry.credential = "app";
    entry.jwt = app;
    if (request.method === "GET" && url.pathname === "/app") return reply(response, 200, { id: Number(appId), slug, permissions, events });
    if ((match = /^\/app\/installations\/(\d+)$/.exec(url.pathname))) {
      const installation = installations.get(Number(match[1]));
      if (!installation) return reply(response, 404, { message: "Not Found" });
      if (request.method === "GET") return reply(response, 200, describe(installation));
      if (request.method === "DELETE") {
        installations.delete(installation.id);
        for (const [token, held] of tokens) if (held.installationId === installation.id) tokens.delete(token);
        uninstalled.push(installation.id);
        return reply(response, 204);
      }
    }
    if (request.method === "POST" && (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname))) {
      const installation = installations.get(Number(match[1]));
      if (!installation) return reply(response, 404, { message: "Not Found" });
      if (installation.suspended_at) return reply(response, 403, { message: "This installation has been suspended" });
      const token = `ghs_stub_${++minted}`;
      const expiresAt = Date.now() + tokenTtlMs;
      tokens.set(token, { installationId: installation.id, expiresAt });
      return reply(response, 201, { token, expires_at: new Date(expiresAt).toISOString(), permissions, repository_selection: installation.repository_selection });
    }
    if (request.method === "GET" && (match = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname))) {
      const name = match[1].toLowerCase();
      const installation = [...installations.values()].find((candidate) => candidate.repositories.some((repository) => repository.full_name.toLowerCase() === name));
      return installation ? reply(response, 200, describe(installation)) : reply(response, 404, { message: "Not Found" });
    }
    return reply(response, 404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    clientId,
    clientSecret,
    installations,
    tokens,
    userTokens,
    requests,
    uninstalled,
    revoked,
    // Adds or replaces an installation. Repositories are "owner/name" strings or { full_name, private } objects. For an
    // organization (type "Organization"), members maps a login to "all" or the repositories that person can reach.
    install,
    // The GitHub user signed in to github.com in the browser, or null.
    signIn(login) {
      browser = login;
      if (login) userId(login);
    },
    userId,
    // What the person does on the next visit to the install page: { id, repositories, login?, type?, members? }
    // installs, { existing: id } opens an installation that already exists and saves it, { request: true } asks an
    // organization's owner instead.
    willInstall(choice) {
      nextInstall = choice;
    },
    // The person presses Cancel on the authorize page.
    denyAuthorization(value = true) {
      denying = value;
    },
    // Every request answers this status until it is set back to null.
    failWith(status) {
      failing = status;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Plays the person's browser: opens an address and follows every redirect until one leaves the web (turtl://) or
// reaches the turtl web app. fetchPage(url) answers one address without following redirects; by default it is fetch.
export async function browse(start, { fetchPage = (url) => fetch(url, { redirect: "manual" }), stopAt = (url) => !/^https?:\/\//.test(url) || /\/add-project(\?|$)/.test(url) } = {}) {
  const visited = [];
  let url = start;
  for (let hop = 0; hop < 12; hop++) {
    if (stopAt(url)) return { url, visited };
    visited.push(url);
    const response = await fetchPage(url);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return { url, visited, status: response.status, text: await response.text() };
    url = new URL(location, url).href;
  }
  throw new Error("Too many redirects from " + start);
}
