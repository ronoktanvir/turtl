import { createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";

const decode = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
const reply = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

// A stand-in for the parts of GitHub's REST API that convex/github calls. It checks credentials the way GitHub
// documents them: an app JWT must be RS256, signed by the app's key, name the app as issuer, be issued in the past
// and expire within ten minutes; an installation token must be one this server minted and must not have expired.
// It is not GitHub: it proves turtl's side of the exchange and nothing about GitHub's.
export async function startGithubStub({ appId, publicKey, slug = "turtl-on-call", permissions = {}, events = [], tokenTtlMs = 3_600_000, port = 0 }) {
  const key = createPublicKey(publicKey);
  const installations = new Map();
  const tokens = new Map();
  const requests = [];
  let minted = 0;
  let failing = null;

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

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://github.stub");
    const authorization = request.headers.authorization;
    const entry = { method: request.method, path: url.pathname, credential: "refused" };
    requests.push(entry);
    if (failing) return reply(response, failing, { message: "Server Error" });

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

    const app = appCredential(authorization);
    if (!app) return reply(response, 401, { message: "A JSON web token could not be decoded" });
    entry.credential = "app";
    entry.jwt = app;
    let match;
    if (request.method === "GET" && url.pathname === "/app") return reply(response, 200, { id: Number(appId), slug, permissions, events });
    if (request.method === "GET" && (match = /^\/app\/installations\/(\d+)$/.exec(url.pathname))) {
      const installation = installations.get(Number(match[1]));
      return installation ? reply(response, 200, describe(installation)) : reply(response, 404, { message: "Not Found" });
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
    installations,
    tokens,
    requests,
    // Adds or replaces an installation. Repositories are "owner/name" strings or { full_name, private } objects.
    install({ id, login, type = "User", selection = "selected", suspended = false, repositories = [] }) {
      const installation = {
        id,
        account: { login, type },
        repository_selection: selection,
        suspended_at: suspended ? new Date().toISOString() : null,
        repositories: repositories.map((repository, index) => {
          const fields = typeof repository === "string" ? { full_name: repository } : repository;
          return { id: id * 100_000 + index + 1, name: fields.full_name.split("/")[1], private: true, ...fields };
        }),
      };
      installations.set(id, installation);
      return installation;
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
