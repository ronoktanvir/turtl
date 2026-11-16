import { createServer } from "node:http";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";

// A stand-in for the three outside services sign-in talks to, served over HTTP on a port the system picks:
// - GitHub's OAuth pages and API (under /github, the shape GitHub Enterprise uses, so the provider's
//   `enterprise.baseUrl` points here),
// - Apple's published signing keys (/apple/auth/keys), with a key pair made here so tests can sign identity tokens,
// - Apple's token endpoints (/apple/auth/token and /apple/auth/revoke), which check the client secret the way Apple
//   documents it (ES256, signed by the team's Sign in with Apple key, naming the team, the bundle id and Apple), trade
//   a code from issueAppleCode once for a refresh token, and keep each revoked token,
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

export async function startAuthStandIn({ host = "127.0.0.1", port = 0, githubUser = STAND_IN_GITHUB_USER, bundleId = "com.turtl.oncall" } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "stand-in-apple-key";
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, use: "sig", alg: "RS256" }] };
  const emails = [];
  const requests = [];
  const codes = new Set();
  // The team's Sign in with Apple key, as Apple's developer site hands it out (a P-256 key in a .p8 file).
  const teamKey = await generateKeyPair("ES256", { extractable: true });
  const appleClient = { teamId: "STANDINTM1", keyId: "STANDINKY1", privateKey: await exportPKCS8(teamKey.privateKey) };
  const appleCodes = new Map();
  const appleRefreshTokens = new Map();
  const appleRevoked = [];
  const appleClientSecret = async (secret, clientId) => {
    try {
      const { payload, protectedHeader } = await jwtVerify(secret ?? "", teamKey.publicKey, { algorithms: ["ES256"], issuer: appleClient.teamId, audience: "https://appleid.apple.com", subject: clientId });
      return protectedHeader.kid === appleClient.keyId && typeof payload.iat === "number" && clientId === bundleId;
    } catch {
      return false;
    }
  };

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
    if ((url.pathname === "/apple/auth/token" || url.pathname === "/apple/auth/revoke") && request.method === "POST") {
      const form = new URLSearchParams(body);
      if (!(await appleClientSecret(form.get("client_secret"), form.get("client_id")))) return json(response, 400, { error: "invalid_client" });
      if (url.pathname === "/apple/auth/revoke") {
        // Apple answers 200 for a token it revoked and for one that was already invalid.
        appleRevoked.push({ token: form.get("token"), hint: form.get("token_type_hint") });
        appleRefreshTokens.delete(form.get("token"));
        response.writeHead(200);
        return response.end();
      }
      const grant = appleCodes.get(form.get("code"));
      if (form.get("grant_type") !== "authorization_code" || !grant || grant.used) return json(response, 400, { error: "invalid_grant" });
      grant.used = true;
      const refreshToken = `stand-in-apple-refresh-${appleRefreshTokens.size + appleRevoked.length + 1}`;
      appleRefreshTokens.set(refreshToken, grant.sub);
      return json(response, 200, { access_token: "stand-in-apple-access", token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, id_token: await signAppleToken({ sub: grant.sub, aud: bundleId }) });
    }
    if (url.pathname === "/email/emails" && request.method === "POST") {
      const message = JSON.parse(body);
      emails.push({ ...message, authorization: request.headers.authorization });
      return json(response, 200, { id: `stand-in-email-${emails.length}` });
    }
    if (url.pathname === "/email/last") return json(response, 200, emails.at(-1) ?? null);
    json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
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
    // What AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID and AUTH_APPLE_PRIVATE_KEY hold for this stand-in.
    appleClient,
    /** A one-time authorization code for this Apple user, as the iPhone's sheet hands the app. */
    issueAppleCode: (sub = "001234.stand-in-apple-user.0001") => {
      const code = `stand-in-apple-code-${appleCodes.size + 1}`;
      appleCodes.set(code, { sub, used: false });
      return code;
    },
    appleRefreshTokens,
    appleRevoked,
    lastCode: () => emails.at(-1)?.text?.match(/\b(\d{8})\b/)?.[1] ?? null,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
