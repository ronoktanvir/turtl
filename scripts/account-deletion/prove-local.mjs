#!/usr/bin/env node
// Deletes an account on a local Convex backend, with accounts on, against stand-ins for Supermemory
// (tests/fixtures/supermemory-stand-in.mjs), GitHub (scripts/github-app/stub.mjs) and Apple's token endpoints
// (tests/fixtures/auth-stand-in.mjs), and checks that nothing of it is left. Convex's own runtime runs the functions,
// the scheduler, storage and the fetches. Nothing here talks to Supermemory, GitHub or Apple.
//   CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3310 --local-site-port 3311   (keep it running)
//   node scripts/account-deletion/prove-local.mjs        (--port <n> serves the stand-ins there; default 8211)
// It refuses to run unless .env.local names a local backend, and removes every variable it set when it ends.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { startAuthStandIn } from "../../tests/fixtures/auth-stand-in.mjs";
import { startSupermemoryStandIn } from "../../tests/fixtures/supermemory-stand-in.mjs";
import { startGithubStub } from "../github-app/stub.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const local = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z_]+)=(\S+)/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const convexUrl = local.EXPO_PUBLIC_CONVEX_URL ?? "";
const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
if (!/^(anonymous|local):/.test(local.CONVEX_DEPLOYMENT ?? "") || !isLocal(convexUrl)) {
  console.error("Refusing to run: .env.local does not name a local Convex backend. Start one with CONVEX_AGENT_MODE=anonymous npx convex dev.");
  process.exit(1);
}
const { adminKey } = JSON.parse(readFileSync(join(root, ".convex/local/default/config.json"), "utf8"));
const admin = new ConvexHttpClient(convexUrl);
admin.setAdminAuth(adminKey);

// --- stand-ins, behind one address: /gh -> GitHub, /sm -> Supermemory, anything else -> Apple (and sign-in's others)
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 8211 : Number(process.argv[portIndex + 1]);
const front = `http://127.0.0.1:${port}`;
const githubKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_ID = "424242";
const apple = await startAuthStandIn();
const memory = await startSupermemoryStandIn({ apiKey: "sm-local-proof-" + randomBytes(4).toString("hex") });
const github = await startGithubStub({ appId: APP_ID, publicKey: githubKeys.publicKey.export({ type: "spki", format: "pem" }) });
const routes = [
  ["/gh", github.url],
  ["/sm", memory.url],
  ["", apple.url],
];
const proxy = createServer((incoming, outgoing) => {
  const [prefix, target] = routes.find(([start]) => incoming.url.startsWith(start + "/"));
  const url = new URL(incoming.url.slice(prefix.length), target);
  const sent = forward(url, { method: incoming.method, headers: { ...incoming.headers, host: url.host } }, (answer) => {
    outgoing.writeHead(answer.statusCode, answer.headers);
    answer.pipe(outgoing);
  });
  incoming.pipe(sent);
});
await new Promise((resolve) => proxy.listen(port, "127.0.0.1", resolve));

// --- the deployment's variables: accounts on, sign-in keys, and every vendor pointed at a stand-in
const scratch = mkdtempSync(join(tmpdir(), "turtl-account-deletion-"));
const convex = async (...args) => (await promisify(execFile)("npx", ["convex", ...args], { cwd: root, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } })).stdout;
const run = async (name, args = {}) => JSON.parse((await convex("run", name, JSON.stringify(args))).trim() || "null");
const signing = await generateKeyPair("RS256", { extractable: true });
const fromFile = {
  JWT_PRIVATE_KEY: (await exportPKCS8(signing.privateKey)).trimEnd().replace(/\n/g, " "),
  JWKS: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(signing.publicKey)) }] }),
  AUTH_APPLE_PRIVATE_KEY: apple.appleClient.privateKey.trimEnd().replace(/\n/g, " "),
  GITHUB_APP_PRIVATE_KEY: githubKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
};
const plain = {
  AUTH_REQUIRED: "true",
  SITE_URL: "http://localhost:8111",
  AUTH_STAND_IN_URL: front,
  AUTH_APPLE_TEAM_ID: apple.appleClient.teamId,
  AUTH_APPLE_KEY_ID: apple.appleClient.keyId,
  SUPERMEMORY_API_KEY: memory.apiKey,
  SUPERMEMORY_BASE_URL: `${front}/sm`,
  GITHUB_API_URL: `${front}/gh`,
  GITHUB_APP_ID: APP_ID,
  GITHUB_APP_SLUG: "turtl-on-call",
};
const VARIABLES = [...Object.keys(fromFile), ...Object.keys(plain)];
const cleanUp = async () => {
  for (const name of VARIABLES) await convex("env", "remove", name).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
  await new Promise((resolve) => proxy.close(resolve));
  proxy.closeAllConnections?.();
  await Promise.all([apple.close(), memory.close(), github.close()]);
};

let passed = 0;
const step = async (name, body) => {
  await body();
  passed += 1;
  console.log("ok   " + name);
};

try {
  for (const [name, value] of Object.entries(fromFile)) {
    const file = join(scratch, name);
    writeFileSync(file, value, { mode: 0o600 });
    await convex("env", "set", name, "--from-file", file);
  }
  for (const [name, value] of Object.entries(plain)) await convex("env", "set", name, value);
  // Let the backend pick up the variables before signing in.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // --- two accounts with a password, and a third that signs in with Apple
  const password = () => "local proof " + randomBytes(12).toString("hex");
  const subjectOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  const signIn = async (provider, params) => {
    const client = new ConvexHttpClient(convexUrl);
    const { tokens } = await client.action(ref("auth:signIn"), { provider, params });
    client.setAuth(tokens.token);
    const [user, session] = subjectOf(tokens.token).split("|");
    return { client, user, session };
  };
  const accounts = {};
  for (const label of ["alice", "bob"]) {
    const email = `${label}-${randomBytes(3).toString("hex")}@example.com`;
    const secret = password();
    const signedIn = await signIn("password", { email, password: secret, flow: "signUp" });
    accounts[label] = { ...signedIn, email, secret, label };
  }
  const nonce = randomBytes(32).toString("hex");
  const appleUser = "001234.local-proof-carol.0001";
  const identityToken = await apple.signAppleToken({ sub: appleUser, nonce: (await import("node:crypto")).createHash("sha256").update(nonce).digest("hex") });
  accounts.carol = { ...(await signIn("apple", { identityToken, nonce, authorizationCode: apple.issueAppleCode(appleUser) })), label: "carol" };

  // --- what each owns: a project with a case, steps, a proposal and decision, evidence, a chat message, a customer
  // report, a preference, a phone, the AI permission, a code map, a screenshot, copies at Supermemory, a GitHub link
  let installationId = 8100;
  for (const account of Object.values(accounts)) {
    account.installationId = ++installationId;
    github.install({ id: account.installationId, login: `${account.label}-octo`, repositories: [`${account.label}-octo/shop`] });
    const seeded = await admin.mutation(ref("account/localProof:seed"), { account: account.user, label: account.label, installationId: account.installationId });
    const shot = await admin.action(ref("account/localProof:screenshot"), { caseId: seeded.caseId });
    account.appId = seeded.appId;
    account.namespaces = [`app_${seeded.appId}`, `prefs_${seeded.appId}`, `reports_${seeded.appId}`, `code_${seeded.appId}`];
    for (const name of account.namespaces) memory.hold(name, 3);
    account.markers = [account.user, ...(account.email ? [account.email] : []), ...seeded.ids, ...shot];
    // Every row that names the account now (its sessions, sign-in methods, ...), so those ids are looked for afterwards too.
    const before = await admin.query(ref("account/localProof:find"), { markers: account.markers });
    account.markers.push(...Object.values(before.rows).flat().map((row) => JSON.parse(row)._id));
    account.before = await admin.query(ref("account/localProof:find"), { markers: account.markers });
  }
  const tables = (found) => Object.fromEntries(Object.entries(found.rows).map(([table, rows]) => [table, rows.length]));
  console.log("alice before:", JSON.stringify(tables(accounts.alice.before)), `files: ${accounts.alice.before.files.length}`);

  const finished = async (account) => {
    for (let tries = 0; tries < 60; tries++) {
      const record = await run("account/deletion:lookup", { account: account.user });
      if (record?.status === "done") return record;
      // Skip the settle wait: nothing else runs for these accounts on this backend.
      if (record?.stage === "settle" || record?.stage === "waiting") await run("account/deletion:hurry", { account: account.user });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("The deletion did not finish within a minute.");
  };
  const deleteAndWait = async (account) => {
    await account.client.mutation(ref("account/deletion:request"), {});
    return await finished(account);
  };

  await step("deleting is refused to a caller who is not signed in", async () => {
    await assert.rejects(new ConvexHttpClient(convexUrl).mutation(ref("account/deletion:request"), {}), /Sign in to continue/);
  });

  let record;
  await step("Alice asks to be deleted: her session ends at once, Bob's does not", async () => {
    await accounts.alice.client.mutation(ref("account/deletion:request"), {});
    assert.equal(await accounts.alice.client.query(ref("users:viewer"), {}), null, "her token no longer signs anyone in");
    assert.equal((await accounts.bob.client.query(ref("users:viewer"), {}))?.id, accounts.bob.user);
    await assert.rejects(accounts.alice.client.mutation(ref("account/deletion:request"), {}), /Sign in to continue/);
  });

  await step("the job runs to the end on Convex's scheduler", async () => {
    record = await finished(accounts.alice);
    console.log("     record:", JSON.stringify(record));
    assert.equal(record.removed.projects, 1);
    assert.ok(record.vendors.every((task) => task.state !== "pending"));
  });

  await step("no table holds a row of Alice's; her files are gone; GitHub's deleted installation keeps no login", async () => {
    const after = await admin.query(ref("account/localProof:find"), { markers: accounts.alice.markers });
    const left = Object.entries(after.rows).filter(([table]) => table !== "githubInstallations");
    assert.deepEqual(left, [], JSON.stringify(after.rows, null, 1));
    assert.deepEqual(after.files, []);
    for (const row of after.rows.githubInstallations ?? []) {
      const { status, accountLogin } = JSON.parse(row);
      assert.deepEqual({ status, accountLogin }, { status: "deleted", accountLogin: "" });
    }
    console.log(`     before: ${Object.values(accounts.alice.before.rows).flat().length} rows in ${Object.keys(accounts.alice.before.rows).length} tables and ${accounts.alice.before.files.length} file; after: none`);
  });

  await step("Bob's rows and files are exactly as they were", async () => {
    const after = await admin.query(ref("account/localProof:find"), { markers: accounts.bob.markers });
    assert.deepEqual(after, accounts.bob.before);
  });

  await step("Supermemory deleted Alice's namespaces and only hers; GitHub uninstalled her installation and only hers", async () => {
    assert.deepEqual(memory.deleted.sort(), [...accounts.alice.namespaces].sort());
    assert.ok(accounts.bob.namespaces.every((name) => memory.held.has(name)));
    assert.deepEqual(github.uninstalled, [accounts.alice.installationId]);
    console.log("     Supermemory:", memory.requests.filter((line) => line.startsWith("DELETE")).join(", "));
    console.log("     GitHub:", github.requests.filter((entry) => entry.method === "DELETE").map((entry) => `${entry.method} ${entry.path}`).join(", "));
  });

  await step("signing in again with Alice's password is refused", async () => {
    await assert.rejects(new ConvexHttpClient(convexUrl).action(ref("auth:signIn"), { provider: "password", params: { email: accounts.alice.email, password: accounts.alice.secret, flow: "signIn" } }), /don't match/);
  });

  await step("an account made with Sign in with Apple has its Apple token kept at sign-in and revoked on deletion", async () => {
    const kept = [...apple.appleRefreshTokens.keys()];
    assert.equal(kept.length, 1, "the sign-in traded Apple's code for a refresh token");
    await deleteAndWait(accounts.carol);
    assert.deepEqual(apple.appleRevoked, [{ token: kept[0], hint: "refresh_token" }]);
    const after = await admin.query(ref("account/localProof:find"), { markers: accounts.carol.markers });
    assert.deepEqual(Object.keys(after.rows).filter((table) => table !== "githubInstallations"), []);
    const done = await run("account/deletion:lookup", { account: accounts.carol.user });
    console.log("     Apple:", JSON.stringify(done.vendors.find((task) => task.service === "apple")));
  });

  console.log(`\n${passed} checks passed.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanUp();
}
