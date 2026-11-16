import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// A stand-in for the three outside services sign-in talks to, served over HTTP on a port the system picks:
// - GitHub's OAuth pages and API (under /github, the shape GitHub Enterprise uses, so the provider's
//   `enterprise.baseUrl` points here),
// - Apple's published signing keys (/apple/auth/keys), with a key pair made here so tests can sign identity tokens,
// - Resend's send endpoint (/email/emails), which keeps each message so a test can read the reset code.
// Point a deployment at it with AUTH_STAND_IN_URL. Nothing here talks to GitHub, Apple or Resend.

export const STAND_IN_GITHUB_USER = {
  id: 4242,
  login: "octo-owner",
  name: "Octo Owner",
  email: null,
  // An address that never resolves (.invalid), so a test never loads a real picture from GitHub.
  avatar_url: "https://avatars.stand-in.invalid/u/4242.png",
};
export const STAND_IN_GITHUB_EMAIL = "octo-owner@example.com";

export async function startAuthStandIn({ host = "127.0.0.1", githubUser = STAND_IN_GITHUB_USER } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "stand-in-apple-key";
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, use: "sig", alg: "RS256" }] };
  const emails = [];
  const requests = [];
  const codes = new Set();

  const read = (request) => new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
  const json = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    requests.push(`${request.method} ${url.pathname}`);
    const body = await read(request);
    if (url.pathname === "/github/login/oauth/authorize") {
      // GitHub asks the person and sends them back with a code. The stand-in says yes at once.
      const code = `stand-in-code-${codes.size + 1}`;
      codes.add(code);
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      if (url.searchParams.get("state")) back.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { Location: back.toString() });
      return response.end();
    }
    if (url.pathname === "/github/login/oauth/access_token" && request.method === "POST") {
      const code = new URLSearchParams(body).get("code");
      if (!codes.delete(code)) return json(response, 400, { error: "bad_verification_code" });
      return json(response, 200, { access_token: `stand-in-token-for-${code}`, token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url.pathname === "/github/api/v3/user") return json(response, 200, githubUser);
    if (url.pathname === "/github/api/v3/user/emails") return json(response, 200, [{ email: STAND_IN_GITHUB_EMAIL, primary: true, verified: true, visibility: null }]);
    if (url.pathname === "/apple/auth/keys") return json(response, 200, jwks);
    if (url.pathname === "/email/emails" && request.method === "POST") {
      const message = JSON.parse(body);
      emails.push({ ...message, authorization: request.headers.authorization });
      return json(response, 200, { id: `stand-in-email-${emails.length}` });
    }
    if (url.pathname === "/email/last") return json(response, 200, emails.at(-1) ?? null);
    json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const url = `http://${host}:${server.address().port}`;

  /** An identity token as Apple would sign it, with these claims over sensible defaults. */
  async function signAppleToken(claims = {}, { key = privateKey, keyId = kid } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const { iss = "https://appleid.apple.com", aud = "com.turtl.oncall", iat = now, exp = now + 600, ...rest } = claims;
    return await new SignJWT({ sub: "001234.stand-in-apple-user.0001", email: "abc123@privaterelay.appleid.com", email_verified: "true", is_private_email: "true", ...rest })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
  }

  return {
    url,
    emails,
    requests,
    jwks,
    signAppleToken,
    lastCode: () => emails.at(-1)?.text?.match(/\b(\d{8})\b/)?.[1] ?? null,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
