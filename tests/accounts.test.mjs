import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { createLocalJWKSet, generateKeyPair } from "jose";
import ts from "typescript";
import { tableProblems, variables } from "../release/backend-env.mjs";
import { startAuthStandIn } from "./fixtures/auth-stand-in.mjs";

// Accounts and sign-in (convex/auth*, convex/users.ts, data/account). The backend modules run here with Convex Auth's
// library replaced by an in-memory stand-in that behaves like it (accounts keyed by provider and id, its error
// codes), against tests/fixtures/auth-stand-in.mjs for Apple's keys and the reset email. Nothing talks to Apple,
// GitHub or Resend.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const realAuth = await import("@convex-dev/auth/server");
const VARIABLES = [
  "AUTH_REQUIRED", "AUTH_STAND_IN_URL", "AUTH_RESEND_KEY", "AUTH_EMAIL_FROM", "AUTH_APPLE_BUNDLE_ID", "AUTH_APPLE_TEAM_ID", "AUTH_APPLE_KEY_ID", "AUTH_APPLE_PRIVATE_KEY", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "JWT_PRIVATE_KEY", "JWKS", "SITE_URL",
  "CONVEX_CLOUD_URL", "NEW_ACCOUNTS_PER_HOUR", "NEW_ACCOUNTS_PER_DAY", "SECRETS_ENCRYPTION_KEY",
];
// The key that seals Apple's refresh tokens (convex/secrets/seal.ts): 32 bytes in base64, made for these tests.
const SEALING_KEY = Buffer.alloc(32, 7).toString("base64");

const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
const registered = (kind) => (definition) => ({ kind, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal") },
  "convex/_generated/server": {
    query: registered("query"),
    mutation: registered("mutation"),
    action: registered("action"),
    internalQuery: registered("query"),
    internalMutation: registered("mutation"),
    internalAction: registered("action"),
  },
};

function createLoader(mocks = {}) {
  const loaded = new Map();
  const load = (file) => {
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
    });
    const require = (name) => {
      if (name in mocks) return mocks[name];
      if (!name.startsWith(".")) return nodeRequire(name);
      const target = resolve(dirname(file), name);
      const key = target.slice(root.length + 1);
      if (key in mocks) return mocks[key];
      if (key in generated) return generated[key];
      return load(target + ".ts");
    };
    runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: file })(require, module.exports, module);
    return module.exports;
  };
  return (path) => load(resolve(root, path));
}

// Convex Auth's account functions with the same contract as @convex-dev/auth 0.0.98 (node_modules/@convex-dev/auth/src):
// retrieveAccount throws "InvalidAccountId", "InvalidSecret" or "TooManyFailedAttempts", and counts wrong passwords
// per account in authRateLimits (10 an hour, checked before the password); createAccount throws "Account <id> already
// exists"; signInViaProvider keeps one code per account in authVerificationCodes (a new one replaces it), and checks a
// code the way verifyCodeAndSignIn does: wrong codes counted per address when params carry one, the code matched to
// accountId when given, and "Could not verify code" for any failure. Accounts and users stay in memory; codes and
// counts live in the world's database, where turtl's own mutations read them.
const MAX_FAILED_PER_HOUR = 10;
function fakeAuthLibrary() {
  const accounts = [];
  const users = [];
  const sessions = [];
  const invalidated = [];
  let counter = 0;
  let rateLimited = false;
  const find = (provider, id) => accounts.find((row) => row.provider === provider && row.providerAccountId === id);
  let config = null;
  const db = () => library.mutationCtx.db;
  const limitOf = (identifier) => db().query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", identifier)).unique();
  // Tries come back at 10 an hour, as in the library's rateLimit.ts.
  const left = (row) => Math.min(MAX_FAILED_PER_HOUR, row.attemptsLeft + ((Date.now() - row.lastAttemptTime) * MAX_FAILED_PER_HOUR) / 3_600_000);
  const limited = async (identifier) => {
    const row = await limitOf(identifier);
    return row !== null && left(row) < 1;
  };
  const failed = async (identifier) => {
    const row = await limitOf(identifier);
    if (row) await db().patch(row._id, { attemptsLeft: left(row) - 1, lastAttemptTime: Date.now() });
    else await db().insert("authRateLimits", { identifier, attemptsLeft: MAX_FAILED_PER_HOUR - 1, lastAttemptTime: Date.now() });
  };
  const forgive = async (identifier) => {
    const row = await limitOf(identifier);
    if (row) await db().delete(row._id);
  };
  const checkCode = async (provider, accountId, params, identifier) => {
    const row = await db().query("authVerificationCodes").withIndex("code", (q) => q.eq("code", sha(params.code))).unique();
    if (!row) return null;
    if (row.expirationTime < Date.now()) return (await db().delete(row._id), null);
    if (accountId === undefined && identifier === undefined && params.code.length < 20) return null;
    const account = accounts.find((candidate) => candidate._id === row.accountId);
    if (!account || (accountId !== undefined && accountId !== row.accountId)) return null;
    if (accountId === undefined && identifier !== undefined && account.providerAccountId !== identifier) return null;
    if (row.provider !== provider.id) return null;
    try {
      await provider.authorize?.(params, account);
    } catch {
      return null;
    }
    await db().delete(row._id);
    return account;
  };
  const library = {
    authTables: realAuth.authTables,
    // convex/auth.ts's configuration, kept so createAccount can run its callback the way the library does.
    convexAuth(given) {
      config = given;
      return { auth: {}, signIn: {}, signOut: {}, store: {}, isAuthenticated: {} };
    },
    /** The mutation context the library's own mutation would give the callbacks; the world sets it. */
    mutationCtx: null,
    async createAccount(_ctx, { provider, account, profile, shouldLinkViaEmail }) {
      assert.equal(shouldLinkViaEmail, false, "accounts are never linked by email");
      if (find(provider, account.id)) throw new Error(`Account ${account.id} already exists`);
      // The library calls this inside the mutation that makes the user, so a throw leaves no user or account behind.
      await config?.callbacks?.afterUserCreatedOrUpdated?.(library.mutationCtx, { userId: "users:" + (counter + 1), existingUserId: null, type: "credentials" });
      const user = { _id: "users:" + ++counter, ...profile };
      users.push(user);
      const row = { _id: "authAccounts:" + ++counter, userId: user._id, provider, providerAccountId: account.id, ...(account.secret !== undefined ? { secret: "hashed:" + account.secret } : {}) };
      accounts.push(row);
      return { account: structuredClone(row), user: structuredClone(user) };
    },
    async retrieveAccount(_ctx, { provider, account }) {
      const row = find(provider, account.id);
      if (!row) throw new Error("InvalidAccountId");
      if (account.secret !== undefined) {
        if (rateLimited || (await limited(row._id))) throw new Error("TooManyFailedAttempts");
        if (row.secret !== "hashed:" + account.secret) {
          await failed(row._id);
          throw new Error("InvalidSecret");
        }
        await forgive(row._id);
      }
      return { account: structuredClone(row), user: structuredClone(users.find((user) => user._id === row.userId)) };
    },
    async modifyAccountCredentials(_ctx, { provider, account }) {
      const row = find(provider, account.id);
      if (!row) throw new Error(`Cannot modify account with ID ${account.id} because it does not exist`);
      row.secret = "hashed:" + account.secret;
    },
    async invalidateSessions(_ctx, args) {
      invalidated.push(args);
    },
    async signInViaProvider(_ctx, provider, { accountId, params }) {
      if (params.code === undefined) {
        const code = await provider.generateVerificationToken();
        const existing = await db().query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", accountId)).unique();
        if (existing) await db().delete(existing._id);
        await db().insert("authVerificationCodes", { accountId, provider: provider.id, code: sha(code), expirationTime: Date.now() + (provider.maxAge ?? 3600) * 1000, emailVerified: params.email });
        await provider.sendVerificationRequest({ identifier: params.email, token: code });
        return null;
      }
      const identifier = params.email ?? params.phone;
      if (identifier !== undefined && (await limited(identifier))) throw new Error("Could not verify code");
      const account = await checkCode(provider, accountId, params, identifier);
      if (!account) {
        if (identifier !== undefined) await failed(identifier);
        throw new Error("Could not verify code");
      }
      if (identifier !== undefined) await forgive(identifier);
      const sessionId = "authSessions:" + ++counter;
      sessions.push(sessionId);
      return { userId: account.userId, sessionId };
    },
  };
  return { library, accounts, users, invalidated, limit: (value) => (rateLimited = value) };
}

// A small in-memory database: rows by table, read only through an index the real schema defines.
function fakeDb(indexes) {
  const tables = new Map();
  let counter = 0;
  const rows = (table) => (tables.has(table) ? tables.get(table) : tables.set(table, []).get(table));
  const db = {
    insert: async (table, fields) => {
      const row = { _id: `${table}:${++counter}`, _creationTime: Date.now(), ...structuredClone(fields) };
      rows(table).push(row);
      return row._id;
    },
    get: async (id) => structuredClone([...tables.values()].flat().find((row) => row._id === id) ?? null),
    patch: async (id, fields) => {
      for (const list of tables.values()) {
        const index = list.findIndex((row) => row._id === id);
        if (index !== -1) list[index] = { ...list[index], ...structuredClone(fields) };
      }
    },
    delete: async (id) => {
      for (const list of tables.values()) {
        const index = list.findIndex((row) => row._id === id);
        if (index !== -1) list.splice(index, 1);
      }
    },
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
    query: (table) => ({
      // The single-owner demo first checks that authAccounts is empty (convex/access.ts).
      first: async () => structuredClone(rows(table)[0] ?? null),
      // Only the shape convex/auth/appleTokens.ts uses: rows where a field is (eq) or is not (neq) a value.
      filter: (build) => {
        const holds = build({ field: (name) => name, eq: (name, value) => (row) => row[name] === value, neq: (name, value) => (row) => row[name] !== value });
        return { take: async (count) => structuredClone(rows(table).filter(holds).slice(0, count)) };
      },
      withIndex: (name, build) => {
        const fields = indexes[table]?.[name];
        assert.ok(fields, `${table} has no index ${name}`);
        const conditions = [];
        const tests = { eq: (a, b) => a === b, lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b };
        const range = Object.fromEntries(Object.entries(tests).map(([operator, holds]) => [operator, (field, value) => (conditions.push([field, value, holds]), range)]));
        build(range);
        conditions.forEach(([field], position) => assert.equal(field, fields[position], `${table}.${name} cannot be read by ${field} here`));
        const matched = () => structuredClone(rows(table).filter((row) => conditions.every(([field, value, holds]) => holds(row[field], value))));
        return { first: async () => matched()[0] ?? null, take: async (count) => matched().slice(0, count), unique: async () => matched()[0] ?? null };
      },
    }),
  };
  return { db, rows: (table) => structuredClone(rows(table)), seed: (table, fields) => db.insert(table, fields) };
}

const indexesOf = (tables) => Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, Object.fromEntries(table.export().indexes.map((index) => [index.indexDescriptor, index.fields]))]));

// One world per test: fresh modules, an empty fake library and database, a running stand-in, and only the variables
// the test sets.
async function world(t, env = {}) {
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  const standIn = await startAuthStandIn();
  t.after(async () => {
    await standIn.close();
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  Object.assign(process.env, { AUTH_STAND_IN_URL: standIn.url }, env);
  const auth = fakeAuthLibrary();
  const load = createLoader({
    "@convex-dev/auth/server": auth.library,
    "@convex-dev/auth/providers/ConvexCredentials": { ConvexCredentials: (config) => ({ type: "credentials", ...config }) },
    // As the library's Email(): its own check wants the address that asked, unless the config replaces it.
    "@convex-dev/auth/providers/Email": {
      Email: (config) => ({
        id: "email",
        type: "email",
        maxAge: 3600,
        authorize: async (params, account) => {
          if (typeof params.email !== "string") throw new Error("Token verification requires an `email` in params of `signIn`.");
          if (account.providerAccountId !== params.email) throw new Error("Short verification code requires a matching `email` in params of `signIn`.");
        },
        ...config,
      }),
    },
    lucia: { Scrypt: class { async hash(secret) { return "scrypt:" + secret; } async verify(hash, secret) { return hash === "scrypt:" + secret; } } },
  });
  const { accountTables } = load("convex/auth/schema.ts");
  const { spendTables } = load("convex/spend/schema.ts");
  const store = fakeDb(indexesOf({ ...accountTables, ...spendTables }));
  const scheduled = [];
  const mutationCtx = { db: store.db, scheduler: { runAt: async (at, fn, args) => void scheduled.push({ at, path: fn.path, args }) } };
  auth.library.mutationCtx = mutationCtx;
  const runMutation = async (fn, args) => {
    const segments = fn.path.split(".").slice(1);
    const name = segments.pop();
    const definition = load("convex/" + segments.join("/") + ".ts")[name];
    assert.equal(definition.kind, "mutation", fn.path + " is not a mutation");
    return await definition.handler(mutationCtx, structuredClone(args));
  };
  return { load, auth, store, standIn, scheduled, actionCtx: { runMutation } };
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const nonce = () => randomBytes(32).toString("hex");
const refusal = (message) => (error) => error?.data === message;

test("email addresses and passwords are checked the same way in the app and the backend", async (t) => {
  const { load } = await world(t);
  const { normalizeEmail, passwordProblem, words, allowedRedirect } = load("convex/auth/rules.ts");
  assert.equal(normalizeEmail("  Owner@Example.COM "), "owner@example.com");
  for (const bad of ["", "owner", "owner@", "@example.com", "two words@example.com", 42, undefined]) assert.equal(normalizeEmail(bad), null);
  assert.equal(passwordProblem("short", "a@b.co"), words.weakPassword);
  assert.equal(passwordProblem("password123", "a@b.co"), words.weakPassword);
  assert.equal(passwordProblem("aaaaaaaaaa", "a@b.co"), words.weakPassword);
  assert.equal(passwordProblem("owner@example.com", "owner@example.com"), words.passwordIsEmail);
  assert.equal(passwordProblem("x".repeat(129), "a@b.co"), words.passwordTooLong);
  assert.equal(passwordProblem("tide pools at dawn", "a@b.co"), null);
  // Sign-in codes go only to the app's own link or the configured site.
  const site = "https://ronoktanvir.github.io/turtl";
  assert.equal(allowedRedirect("turtl:///", site), "turtl:///");
  assert.equal(allowedRedirect("/", site), site + "/");
  assert.equal(allowedRedirect(site + "/?x=1", site), site + "/?x=1");
  for (const elsewhere of ["https://evil.example.com", "//evil.example.com", site + ".evil.example.com", "exp://192.168.0.2:8081"]) assert.equal(allowedRedirect(elsewhere, site), null, elsewhere);
});

test("an Apple identity token is accepted only with Apple's signature, issuer, audience, expiry and this sign-in's nonce", async (t) => {
  const { load, standIn } = await world(t);
  const { verifyAppleIdentityToken } = load("convex/auth/apple.ts");
  const keys = createLocalJWKSet(standIn.jwks);
  const audience = "com.turtl.oncall";
  const raw = nonce();
  const identity = await verifyAppleIdentityToken(await standIn.signAppleToken({ nonce: sha(raw), email: "Ada@PrivateRelay.AppleID.com" }), raw, { keys, audience });
  assert.equal(identity.sub, "001234.stand-in-apple-user.0001");
  assert.equal(identity.email, "ada@privaterelay.appleid.com");
  assert.equal(identity.nonceHash, sha(raw));
  const other = (await generateKeyPair("RS256")).privateKey;
  const now = Math.floor(Date.now() / 1000);
  const refused = {
    "a token from another app": [{ aud: "com.someone.else" }],
    "a token from another issuer": [{ iss: "https://evil.example.com" }],
    "an expired token": [{ iat: now - 3600, exp: now - 1800 }],
    "a token for another sign-in's nonce": [{ nonce: sha("another nonce entirely, long enough to pass") }],
    "a token without a nonce": [{ nonce: undefined }],
    "a token signed by another key": [{}, { key: other }],
  };
  for (const [label, [claims, options]] of Object.entries(refused)) {
    const token = await standIn.signAppleToken({ nonce: sha(raw), ...claims }, options);
    await assert.rejects(verifyAppleIdentityToken(token, raw, { keys, audience }), refusal("Apple didn't confirm this sign-in. Try Sign in with Apple again."), label);
  }
  await assert.rejects(verifyAppleIdentityToken("not a token", raw, { keys, audience }), /Apple didn't confirm/);
  await assert.rejects(verifyAppleIdentityToken(await standIn.signAppleToken({ nonce: sha("short") }), "short", { keys, audience }), /Apple didn't confirm/, "a short nonce");
});

test("Sign in with Apple makes an account once, signs the same person in again, and refuses a replayed token", async (t) => {
  const { load, auth, standIn, store, scheduled, actionCtx } = await world(t);
  const provider = load("convex/auth/apple.ts").apple();
  assert.equal(provider.id, "apple");
  const raw = nonce();
  const token = await standIn.signAppleToken({ nonce: sha(raw) });
  const first = await provider.authorize({ identityToken: token, nonce: raw, name: "  Ada Apple  " }, actionCtx);
  assert.deepEqual(auth.users.map(({ name, email }) => ({ name, email })), [{ name: "Ada Apple", email: "abc123@privaterelay.appleid.com" }]);
  assert.equal(auth.accounts[0].provider, "apple");
  assert.equal(auth.accounts[0].secret, undefined, "an Apple account holds no secret");
  assert.ok(standIn.requests.includes("GET /apple/auth/keys"), "the keys came from the published key set");
  await assert.rejects(provider.authorize({ identityToken: token, nonce: raw }, actionCtx), /Apple didn't confirm/, "the same token twice");
  const again = nonce();
  const second = await provider.authorize({ identityToken: await standIn.signAppleToken({ nonce: sha(again) }), nonce: again }, actionCtx);
  assert.equal(second.userId, first.userId);
  assert.equal(auth.users.length, 1);
  // Each used nonce is remembered until its token has expired, then forgotten.
  assert.equal(store.rows("authAppleNonces").length, 2);
  assert.equal(scheduled.length, 2);
  assert.ok(scheduled.every((job) => job.path === "internal.auth.apple.forgetNonce" && job.at > Date.now()));
  await load("convex/auth/apple.ts").forgetNonce.handler({ db: store.db }, scheduled[0].args);
  assert.equal(store.rows("authAppleNonces").length, 1);
});

test("Sign in with Apple keeps Apple's refresh token to revoke later, only for the same Apple user, and never stops the sign-in", async (t) => {
  const { load, standIn, store, actionCtx } = await world(t);
  const logged = [];
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, (...args) => logged.push(args.join(" ")));
  const provider = load("convex/auth/apple.ts").apple();
  const signIn = async (code) => {
    const raw = nonce();
    return await provider.authorize({ identityToken: await standIn.signAppleToken({ nonce: sha(raw) }), nonce: raw, authorizationCode: code }, actionCtx);
  };
  // Without the team's key turtl cannot trade the code: the sign-in works and the log says what is missing.
  const first = await signIn(standIn.issueAppleCode());
  assert.ok(first.userId);
  assert.deepEqual(store.rows("authAppleTokens"), []);
  assert.match(logged.at(-1), /AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID or AUTH_APPLE_PRIVATE_KEY is not set/);
  Object.assign(process.env, { AUTH_APPLE_TEAM_ID: standIn.appleClient.teamId, AUTH_APPLE_KEY_ID: standIn.appleClient.keyId, AUTH_APPLE_PRIVATE_KEY: standIn.appleClient.privateKey.replace(/\n/g, " "), SECRETS_ENCRYPTION_KEY: SEALING_KEY });
  const second = await signIn(standIn.issueAppleCode());
  assert.equal(second.userId, first.userId);
  const [row] = store.rows("authAppleTokens");
  assert.equal(row.userId, first.userId);
  // Kept sealed (review: Apple refresh tokens were stored in the clear); opened only to revoke it.
  const { openKept } = load("convex/auth/appleTokens.ts");
  const kept = { ...row, refreshToken: (await openKept({ id: row._id, sealedToken: row.sealedToken, keyId: row.keyId }, first.userId, await load("convex/secrets/seal.ts").sealingKey())).refreshToken };
  assert.ok(standIn.appleRefreshTokens.has(kept.refreshToken), "the token Apple handed out for this code");
  assert.equal(row.refreshToken, undefined);
  // A code that belongs to another Apple account is never kept under this one; a used code is refused by Apple. Both still sign in.
  assert.ok(await signIn(standIn.issueAppleCode("000999.someone-else.0001")));
  assert.match(logged.at(-1), /no Apple token was kept to revoke later \(the authorization code belongs to another Apple account\)/);
  const used = standIn.issueAppleCode();
  await signIn(used);
  assert.ok(await signIn(used));
  assert.match(logged.at(-1), /Apple answered with an error \(status 400\)/);
  assert.equal(store.rows("authAppleTokens").length, 2);
  // Revoking: Apple accepts the client secret signed with the team's key, and refuses one signed for another key.
  const { revokeToken } = load("convex/auth/appleTokens.ts");
  const { appleClient } = load("convex/auth/settings.ts");
  assert.deepEqual(await revokeToken(appleClient(), kept.refreshToken), { ok: true });
  assert.deepEqual(standIn.appleRevoked, [{ token: kept.refreshToken, hint: "refresh_token" }]);
  process.env.AUTH_APPLE_KEY_ID = "ANOTHERKEY";
  assert.deepEqual(await revokeToken(appleClient(), kept.refreshToken), { ok: false, reason: "Apple answered with an error (status 400)" });
  const secrets = [kept.refreshToken, standIn.appleClient.privateKey.split("\n")[1], used];
  assert.ok(logged.every((line) => secrets.every((secret) => !line.includes(secret))), "no token, code or key in any log line");
});

// Review, "Worth a second look": Apple refresh tokens were stored in the clear, so anyone holding a copy of the database
// (a backup, an export, someone with dashboard access) could use every Apple user's token. Now they are sealed like an
// owner's secrets (convex/secrets/seal.ts), bound to the user, and opened only in the action that revokes them.
test("ATTACK (review): a copy of the database holds no usable Apple token; it opens only for its own user, and revokes at deletion", async (t) => {
  const { load, standIn, store, actionCtx } = await world(t, { SECRETS_ENCRYPTION_KEY: SEALING_KEY });
  const logged = [];
  for (const level of ["log", "info", "warn", "error"]) t.mock.method(console, level, (...args) => logged.push(args.join(" ")));
  Object.assign(process.env, { AUTH_APPLE_TEAM_ID: standIn.appleClient.teamId, AUTH_APPLE_KEY_ID: standIn.appleClient.keyId, AUTH_APPLE_PRIVATE_KEY: standIn.appleClient.privateKey.replace(/\n/g, " ") });
  const provider = load("convex/auth/apple.ts").apple();
  const signIn = async (code, sub) => {
    const raw = nonce();
    return await provider.authorize({ identityToken: await standIn.signAppleToken({ nonce: sha(raw), ...(sub && { sub }) }), nonce: raw, authorizationCode: code }, actionCtx);
  };
  const { userId } = await signIn(standIn.issueAppleCode());
  const handedOut = [...standIn.appleRefreshTokens.keys()];
  assert.equal(handedOut.length, 1);
  const copy = JSON.stringify(store.rows("authAppleTokens"));
  assert.ok(!copy.includes(handedOut[0]), "the database copy does not hold Apple's token");
  const [row] = store.rows("authAppleTokens");
  assert.match(row.sealedToken, /^v1\./);

  const { openKept } = load("convex/auth/appleTokens.ts");
  const { sealingKey } = load("convex/secrets/seal.ts");
  const key = await sealingKey();
  const token = { id: row._id, sealedToken: row.sealedToken, keyId: row.keyId };
  assert.deepEqual(await openKept(token, userId, key), { ok: true, refreshToken: handedOut[0] });
  assert.equal((await openKept(token, "users:999", key)).ok, false, "moved onto another user's row, it does not open");
  assert.match((await openKept(token, userId, await sealingKey(Buffer.alloc(32, 9).toString("base64")))).reason, /sealed under an earlier SECRETS_ENCRYPTION_KEY/);
  assert.match((await openKept(token, userId, null)).reason, /SECRETS_ENCRYPTION_KEY is not set/);

  // Account deletion opens it in its own action and Apple revokes it: tests/account-deletion.test.mjs, end to end.

  // Without the key nothing more is kept, not even in the clear, and the log says why; the sign-in still works.
  delete process.env.SECRETS_ENCRYPTION_KEY;
  assert.ok(await signIn(standIn.issueAppleCode()));
  assert.equal(store.rows("authAppleTokens").length, 1);
  assert.match(logged.at(-1), /SECRETS_ENCRYPTION_KEY is not set, or is not 32 bytes, so no Apple token was kept to revoke later/);
  assert.ok(logged.every((line) => !handedOut.some((secret) => line.includes(secret))), "no token in any log line");
});

test("rows kept before Apple tokens were sealed are sealed in place by sealKept, and still open for their user", async (t) => {
  const { load, store } = await world(t, { SECRETS_ENCRYPTION_KEY: SEALING_KEY });
  const users = [await store.seed("users", { email: "a@example.com" }), await store.seed("users", { email: "b@example.com" })];
  const plain = Array.from({ length: 60 }, (_, n) => `legacy-token-${n}`);
  for (const [n, refreshToken] of plain.entries()) await store.seed("authAppleTokens", { userId: users[n % 2], refreshToken, storedAt: n });
  const scheduled = [];
  const call = async (fn, args) => {
    const segments = fn.path.split(".").slice(1);
    const name = segments.pop();
    return await load("convex/" + segments.join("/") + ".ts")[name].handler(ctx, structuredClone(args));
  };
  const ctx = { db: store.db, runQuery: call, runMutation: call, scheduler: { runAfter: async (_delay, fn, args) => void scheduled.push([fn.path, args]) } };
  const { sealKept, openKept } = load("convex/auth/appleTokens.ts");
  assert.deepEqual(await sealKept.handler(ctx, {}), { sealed: 50, more: true });
  assert.deepEqual(scheduled, [["internal.auth.appleTokens.sealKept", {}]], "it calls itself again while rows are left");
  assert.deepEqual(await sealKept.handler(ctx, {}), { sealed: 10, more: false });
  const rows = store.rows("authAppleTokens");
  assert.ok(rows.every((row) => row.refreshToken === undefined && /^v1\./.test(row.sealedToken)));
  assert.ok(!plain.some((token) => JSON.stringify(rows).includes(token)));
  const key = await load("convex/secrets/seal.ts").sealingKey();
  const opened = await Promise.all(rows.map(async (row) => (await openKept({ id: row._id, sealedToken: row.sealedToken, keyId: row.keyId }, row.userId, key)).refreshToken));
  assert.deepEqual(opened.sort(), [...plain].sort());
});

test("a token for another bundle id is refused unless AUTH_APPLE_BUNDLE_ID names it", async (t) => {
  const { load, standIn, actionCtx } = await world(t, { AUTH_APPLE_BUNDLE_ID: "com.owner.turtl" });
  const provider = load("convex/auth/apple.ts").apple();
  const raw = nonce();
  await assert.rejects(provider.authorize({ identityToken: await standIn.signAppleToken({ nonce: sha(raw) }), nonce: raw }, actionCtx), /Apple didn't confirm/);
  const next = nonce();
  assert.ok(await provider.authorize({ identityToken: await standIn.signAppleToken({ nonce: sha(next), aud: "com.owner.turtl" }), nonce: next }, actionCtx));
});

test("email and password: sign up, sign in, and each refusal in plain words", async (t) => {
  const { load, auth } = await world(t);
  const { words } = load("convex/auth/rules.ts");
  const provider = load("convex/auth/password.ts").password();
  assert.equal(provider.id, "password");
  const ctx = {};
  const created = await provider.authorize({ flow: "signUp", email: " Owner@Example.com ", password: "tide pools at dawn" }, ctx);
  assert.deepEqual(auth.users.map(({ email }) => email), ["owner@example.com"], "sign-up stores only the email");
  assert.equal(auth.accounts[0].secret, "hashed:tide pools at dawn");
  assert.deepEqual(await provider.authorize({ flow: "signIn", email: "OWNER@example.com", password: "tide pools at dawn" }, ctx), created);
  await assert.rejects(provider.authorize({ flow: "signUp", email: "owner@example.com", password: "another good one" }, ctx), refusal(words.accountExists));
  await assert.rejects(provider.authorize({ flow: "signUp", email: "new@example.com", password: "12345678" }, ctx), refusal(words.weakPassword));
  await assert.rejects(provider.authorize({ flow: "signUp", email: "not an email", password: "tide pools at dawn" }, ctx), refusal(words.badEmail));
  await assert.rejects(provider.authorize({ flow: "signIn", email: "owner@example.com", password: "wrong password" }, ctx), refusal(words.wrongPassword));
  await assert.rejects(provider.authorize({ flow: "signIn", email: "nobody@example.com", password: "wrong password" }, ctx), refusal(words.wrongPassword), "an unknown email reads like a wrong password");
  await assert.rejects(provider.authorize({ flow: "signIn", email: "owner@example.com" }, ctx), refusal(words.wrongPassword));
  auth.limit(true);
  await assert.rejects(provider.authorize({ flow: "signIn", email: "owner@example.com", password: "tide pools at dawn" }, ctx), refusal(words.tooManyTries));
  auth.limit(false);
  await assert.rejects(provider.authorize({ flow: "somethingElse", email: "owner@example.com" }, ctx), refusal(words.unknown));
  // Without an email service, reset is off and says so.
  await assert.rejects(provider.authorize({ flow: "reset", email: "owner@example.com" }, ctx), refusal(words.resetOff));
  await assert.rejects(provider.authorize({ flow: "reset-verification", email: "owner@example.com", code: "12345678", newPassword: "a new password" }, ctx), refusal(words.resetOff));
});

test("password reset emails a one-time code, changes the password, and signs out every other device", async (t) => {
  const { load, auth, standIn, actionCtx: ctx } = await world(t, { AUTH_RESEND_KEY: "stand-in-key", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>" });
  const { words } = load("convex/auth/rules.ts");
  const provider = load("convex/auth/password.ts").password();
  await provider.authorize({ flow: "signUp", email: "owner@example.com", password: "tide pools at dawn" }, ctx);
  assert.equal(await provider.authorize({ flow: "reset", email: "nobody@example.com" }, ctx), null);
  assert.equal(standIn.emails.length, 0, "no email for an address without an account, and the same answer");
  assert.equal(await provider.authorize({ flow: "reset", email: "Owner@example.com" }, ctx), null);
  assert.equal(await provider.authorize({ flow: "reset", email: "owner@example.com" }, ctx), null);
  assert.equal(standIn.emails.length, 1, "no second email while the first code works, and the same answer");
  const [email] = standIn.emails;
  assert.deepEqual([email.to, email.from, email.authorization], [["owner@example.com"], "turtl <no-reply@example.com>", "Bearer stand-in-key"]);
  const code = standIn.lastCode();
  assert.match(code, /^\d{8}$/);
  assert.match(email.subject, new RegExp(code));
  await assert.rejects(provider.authorize({ flow: "reset-verification", email: "owner@example.com", code: "00000000", newPassword: "a new password" }, ctx), refusal(words.wrongCode));
  await assert.rejects(provider.authorize({ flow: "reset-verification", email: "owner@example.com", code, newPassword: "short" }, ctx), refusal(words.weakPassword));
  const signedIn = await provider.authorize({ flow: "reset-verification", email: "owner@example.com", code: ` ${code.slice(0, 4)} ${code.slice(4)} `, newPassword: "a new password" }, ctx);
  assert.ok(signedIn.sessionId);
  assert.equal(auth.accounts[0].secret, "hashed:a new password");
  assert.deepEqual(auth.invalidated, [{ userId: signedIn.userId, except: [signedIn.sessionId] }]);
  await assert.rejects(provider.authorize({ flow: "reset-verification", email: "owner@example.com", code, newPassword: "a third password" }, ctx), refusal(words.wrongCode), "a code works once");
});

test("the reset email reports a refused send without echoing the reply, and is off without a sender", async (t) => {
  const { load } = await world(t, { AUTH_RESEND_KEY: "stand-in-key" });
  const email = load("convex/auth/email.ts");
  assert.equal(email.resetProvider(), undefined, "a key without a sender leaves reset off");
  process.env.AUTH_EMAIL_FROM = "turtl <no-reply@example.com>";
  const errors = t.mock.method(console, "error", () => {});
  await assert.rejects(email.sendResetCode("owner@example.com", "12345678", async () => new Response("owner@example.com is not allowed", { status: 403 })), /couldn't send the email/);
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments.join(" ")), ["The reset email was not accepted (HTTP 403)."]);
  const codes = await Promise.all(Array.from({ length: 50 }, () => email.resetProvider().generateVerificationToken()));
  assert.ok(codes.every((code) => /^\d{8}$/.test(code)));
  assert.ok(new Set(codes).size > 45, "codes vary");
  // A new code goes out only when none still works and none went out in the last minute.
  const { accountTables } = load("convex/auth/schema.ts");
  const store = fakeDb(indexesOf(accountTables));
  const ctx = { db: store.db };
  const reserve = () => email.reserveReset.handler(ctx, { accountId: "authAccounts:1" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-15T12:00:00Z") });
  assert.equal(await reserve(), true);
  assert.equal(await reserve(), false, "within a minute of the last one");
  await store.seed("authVerificationCodes", { accountId: "authAccounts:1", provider: "password-reset", code: "hash", expirationTime: Date.now() + 15 * 60_000 });
  t.mock.timers.setTime(Date.parse("2026-11-15T12:05:00Z"));
  assert.equal(await reserve(), false, "the code sent five minutes ago still works, so it is not replaced");
  t.mock.timers.setTime(Date.parse("2026-11-15T12:16:00Z"));
  assert.equal(await reserve(), true, "an expired code may be replaced");
});

// Review finding 6: someone who knows only the owner's address must not be able to keep the owner out. Convex Auth
// refuses an account's right password after 10 wrong ones an hour; the reset is the way back, so a stranger must not be
// able to replace the code the owner was sent, or use up tries the owner's own code needs.
test("after ten wrong passwords from a stranger, the reset lets the owner back in, and a second reset leaves the first code valid", async (t) => {
  const { load, standIn, store, actionCtx: ctx } = await world(t, { AUTH_RESEND_KEY: "stand-in-key", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-15T12:00:00Z") });
  const { words } = load("convex/auth/rules.ts");
  const provider = load("convex/auth/password.ts").password();
  const as = (params) => provider.authorize({ email: "owner@example.com", ...params }, ctx);
  await as({ flow: "signUp", password: "tide pools at dawn" });
  // The stranger: ten wrong passwords, then the owner's right one is refused, as Convex Auth does.
  for (let n = 0; n < 10; n++) await assert.rejects(as({ flow: "signIn", password: `wrong guess ${n}` }), refusal(words.wrongPassword));
  await assert.rejects(as({ flow: "signIn", password: "tide pools at dawn" }), refusal(words.tooManyTries));
  // The stranger asks for a reset (the code goes to the owner), and asks again later while it still works.
  await as({ flow: "reset" });
  const first = standIn.lastCode();
  t.mock.timers.setTime(Date.parse("2026-11-15T12:02:00Z"));
  await as({ flow: "reset" });
  assert.equal(standIn.emails.length, 1, "no new code replaced the first");
  // A few wrong codes from the stranger leave the code working.
  for (const guess of ["11111111", "22222222"]) await assert.rejects(as({ flow: "reset-verification", code: guess, newPassword: "stranger's password" }), refusal(words.wrongCode));
  const back = await as({ flow: "reset-verification", code: first, newPassword: "a new password" });
  assert.ok(back.sessionId, "the owner is signed in");
  assert.ok(await as({ flow: "signIn", password: "a new password" }), "and the new password works at once on another device");
  assert.deepEqual(store.rows("authRateLimits"), [], "no count of wrong tries is left against the account or the address");
  assert.deepEqual(store.rows("authPasswordResets"), []);
});

test("a stranger's wrong codes use up only that code: the owner asks for another and gets back in", async (t) => {
  const { load, standIn, store, actionCtx: ctx } = await world(t, { AUTH_RESEND_KEY: "stand-in-key", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-15T12:00:00Z") });
  const { words } = load("convex/auth/rules.ts");
  const { MAX_CODE_TRIES } = load("convex/auth/email.ts");
  const provider = load("convex/auth/password.ts").password();
  const as = (params) => provider.authorize({ email: "owner@example.com", ...params }, ctx);
  await as({ flow: "signUp", password: "tide pools at dawn" });
  await as({ flow: "reset" });
  const burned = standIn.lastCode();
  for (let n = 0; n < MAX_CODE_TRIES; n++) await assert.rejects(as({ flow: "reset-verification", code: String(30000000 + n), newPassword: "stranger's password" }), refusal(words.wrongCode));
  await assert.rejects(as({ flow: "reset-verification", code: burned, newPassword: "a new password" }), refusal(words.wrongCode), "that code is used up");
  assert.deepEqual(store.rows("authVerificationCodes"), [], "and dropped");
  assert.deepEqual(store.rows("authRateLimits"), [], "the address is never locked");
  t.mock.timers.setTime(Date.parse("2026-11-15T12:01:01Z"));
  await as({ flow: "reset" });
  assert.equal(standIn.emails.length, 2);
  assert.ok((await as({ flow: "reset-verification", code: standIn.lastCode(), newPassword: "a new password" })).sessionId);
});

// Review finding 7: every limit is per account, so a script that makes accounts multiplies them. With accounts on, the
// deployment makes at most so many new accounts an hour and a day, by any method, counted where Convex Auth makes the user.
test("with the deployment's ceiling on new accounts reached, a fresh sign-up is refused in plain words and makes nothing", async (t) => {
  const { load, auth, store } = await world(t, { AUTH_REQUIRED: "true", NEW_ACCOUNTS_PER_HOUR: "2", NEW_ACCOUNTS_PER_DAY: "3" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-15T12:10:00Z") });
  const { ceilingRefusal } = load("convex/spend/limits.ts");
  load("convex/auth.ts");
  const provider = load("convex/auth/password.ts").password();
  const signUp = (email) => provider.authorize({ flow: "signUp", email, password: "tide pools at dawn" }, {});
  await signUp("one@example.com");
  await signUp("two@example.com");
  await assert.rejects(signUp("three@example.com"), refusal(ceilingRefusal.accountsThisHour));
  assert.equal(ceilingRefusal.accountsThisHour, "turtl is making a lot of new accounts right now, so it isn't making more this hour. Try again in an hour.");
  assert.deepEqual(auth.users.map((user) => user.email), ["one@example.com", "two@example.com"], "the refused sign-up left no account");
  // Signing in to an account that exists is not a new account.
  assert.ok(await provider.authorize({ flow: "signIn", email: "one@example.com", password: "tide pools at dawn" }, {}));
  // The next hour opens again, up to the day's ceiling.
  t.mock.timers.setTime(Date.parse("2026-11-15T13:10:00Z"));
  await signUp("three@example.com");
  await assert.rejects(signUp("four@example.com"), refusal(ceilingRefusal.accountsToday));
  assert.deepEqual(store.rows("deploymentTotals").map(({ name, value }) => [name, value]).sort(), [["accounts_day", 3], ["accounts_hour", 1]], "the earlier hour's count was dropped");
});

// Review finding 13: the single-owner demo refuses to serve a deployment that holds any account, so it must make none,
// or anyone could close it with one sign-up. The library runs the callback inside the mutation that makes the user.
test("the demo makes no accounts, so a stranger cannot close it by signing up", async (t) => {
  const { load, auth } = await world(t, { NEW_ACCOUNTS_PER_HOUR: "1" });
  load("convex/auth.ts");
  const { NO_SIGN_IN } = load("convex/access.ts");
  const provider = load("convex/auth/password.ts").password();
  for (const email of ["one@example.com", "two@example.com"]) {
    await assert.rejects(provider.authorize({ flow: "signUp", email, password: "tide pools at dawn" }, {}), refusal(NO_SIGN_IN));
  }
  assert.equal(auth.users.length, 0);
  assert.equal(auth.accounts.length, 0, "no row in authAccounts");
});

test("users.mode answers before sign-in; users.viewer returns the signed-in person or null", async (t) => {
  const { load } = await world(t, { AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "secret" });
  const users = load("convex/users.ts");
  const store = fakeDb(indexesOf(realAuth.authTables));
  assert.deepEqual(await users.mode.handler({ db: store.db }, {}), { accounts: false, github: true, passwordReset: false });
  process.env.AUTH_REQUIRED = "true";
  assert.deepEqual(await users.mode.handler({ db: store.db }, {}), { accounts: true, github: true, passwordReset: false });
  const ada = await store.seed("users", { name: "Ada", email: "ada@example.com", image: "https://avatars.example.com/ada.png" });
  await store.seed("authAccounts", { userId: ada, provider: "github", providerAccountId: "4242" });
  await store.seed("authAccounts", { userId: ada, provider: "password", providerAccountId: "ada@example.com", secret: "x" });
  const plain = await store.seed("users", { email: "plain@example.com", image: "http://insecure.example.com/me.png" });
  const adaSession = await store.seed("authSessions", { userId: ada, expirationTime: Date.now() + 60_000 });
  const plainSession = await store.seed("authSessions", { userId: plain, expirationTime: Date.now() + 60_000 });
  const ended = await store.seed("authSessions", { userId: ada, expirationTime: 0 });
  const as = (subject) => ({ db: store.db, auth: { getUserIdentity: async () => (subject ? { subject } : null) } });
  assert.deepEqual(await users.viewer.handler(as(`${ada}|${adaSession}`), {}), { id: ada, name: "Ada", email: "ada@example.com", picture: "https://avatars.example.com/ada.png", methods: ["password", "github"] });
  assert.deepEqual(await users.viewer.handler(as(`${plain}|${plainSession}`), {}), { id: plain, name: null, email: "plain@example.com", picture: null, methods: [] }, "only an https picture is passed on");
  assert.equal(await users.viewer.handler(as(`${ada}|${ended}`), {}), null, "a session that has ended (signed out elsewhere, or the account is being deleted)");
  assert.equal(await users.viewer.handler(as(null), {}), null);
  assert.equal(await users.viewer.handler(as("users:999|authSessions:3"), {}), null, "a deleted user");
  assert.equal(await users.viewer.handler(as("someone-else|x"), {}), null, "an id that is not a user");
});

test("users.account goes through internal.access.account: the account id signed in, a refusal signed out", async (t) => {
  const { load } = await world(t);
  const users = load("convex/users.ts");
  const access = load("convex/access.ts");
  const ctx = (subject) => {
    const auth = { getUserIdentity: async () => (subject ? { subject } : null) };
    return {
      auth,
      runQuery: async (fn, args) => {
        // In the demo, an action first asks that the deployment holds no account (convex/functions.ts).
        assert.ok(["internal.access.account", "internal.access.demoOpen"].includes(fn.path), fn.path);
        // A query's context: a live session, and no account rows (the demo's own check reads that table).
        const db = { normalizeId: (table, id) => (id.startsWith(table + ":") ? id : null), get: async (id) => ({ _id: id, expirationTime: Date.now() + 60_000 }), query: () => ({ first: async () => null }) };
        return await access[fn.path.split(".").pop()].handler({ auth, db }, args);
      },
    };
  };
  assert.equal(await users.account.handler(ctx(null), {}), "solo-owner", "the demo files everything under its one owner");
  process.env.AUTH_REQUIRED = "true";
  assert.equal(await users.account.handler(ctx("users:7|authSessions:9"), {}), "users:7", "the part of the subject before |");
  await assert.rejects(users.account.handler(ctx(null), {}), refusal("Sign in to continue."));
});

test("the review account is made, or given a new password, without logging the password", async (t) => {
  const { load, auth } = await world(t);
  const { ensureAccount } = load("convex/auth/review.ts");
  const logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, level, (...args) => logged.push(args.join(" ")));
  assert.deepEqual(await ensureAccount.handler({}, { email: "Review@Example.com", password: "review pass one" }), { email: "review@example.com", created: true });
  assert.deepEqual(await ensureAccount.handler({}, { email: "review@example.com", password: "review pass two" }), { email: "review@example.com", created: false });
  assert.equal(auth.accounts.length, 1);
  assert.equal(auth.accounts[0].secret, "hashed:review pass two");
  assert.deepEqual(auth.invalidated, [], "a reviewer already signed in stays signed in");
  await assert.rejects(ensureAccount.handler({}, { email: "review@example.com", password: "short" }), /Choose a password/);
  await assert.rejects(ensureAccount.handler({}, { email: "review", password: "review pass three" }), /Enter your email/);
  assert.ok(logged.every((line) => !line.includes("review pass")), "no password in any log line");
});

test("sign-in settings are read by name and reported without values", async (t) => {
  const { load } = await world(t, { JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY----- secret", AUTH_RESEND_KEY: "re_secret", AUTH_EMAIL_FROM: "turtl <a@b.co>" });
  const settings = load("convex/auth/settings.ts");
  const report = await settings.check.handler({}, {});
  assert.deepEqual(report.missing, ["JWKS", "SITE_URL", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"]);
  assert.equal(report.passwordReset, true);
  assert.equal(report.appleAudience, "com.turtl.oncall");
  assert.equal(report.standIn, true);
  assert.ok(!JSON.stringify(report).includes("secret"), "no value leaves the module");
  delete process.env.AUTH_STAND_IN_URL;
  assert.equal(settings.appleKeysUrl(), "https://appleid.apple.com/auth/keys");
  assert.equal(settings.resetEmail().endpoint, "https://api.resend.com/emails");
});

test("the app's sign-in gate: who sees what, and where they are sent", async (t) => {
  const { load } = await world(t);
  const { accountStatus, gateTarget, holdScreens, realSignIn, signInMessage } = load("data/account/status.ts");
  const { words } = load("convex/auth/rules.ts");
  const on = { accounts: true, github: false, passwordReset: false };
  const off = { accounts: false, github: false, passwordReset: false };
  const loading = { isLoading: true, isAuthenticated: false };
  const out = { isLoading: false, isAuthenticated: false };
  const inside = { isLoading: false, isAuthenticated: true };
  assert.equal(accountStatus({ live: false, storeBuild: false, mode: undefined, auth: out }), "demo", "example data has no accounts");
  assert.equal(accountStatus({ live: true, storeBuild: false, mode: off, auth: out }), "demo", "a development build on a backend without accounts is the demo");
  assert.equal(accountStatus({ live: true, storeBuild: true, mode: off, auth: inside }), "accountsOff", "a store build refuses a backend without accounts (RC-04)");
  assert.equal(accountStatus({ live: true, storeBuild: true, mode: undefined, auth: out }), "checking");
  assert.equal(accountStatus({ live: true, storeBuild: false, mode: on, auth: loading }), "checking");
  assert.equal(accountStatus({ live: true, storeBuild: false, mode: on, auth: out }), "signedOut");
  assert.equal(accountStatus({ live: true, storeBuild: true, mode: on, auth: inside }), "signedIn");
  for (const route of ["projects", "project", "case", "live", "review", "add-project", "+not-found"]) assert.equal(gateTarget("signedOut", route), "/", route);
  for (const route of [undefined, "", "sign-in", "sign-up", "reset-password"]) {
    assert.equal(gateTarget("signedOut", route), null);
    assert.equal(gateTarget("signedIn", route), "/projects", "signed in, Login sends you on: " + route);
  }
  for (const status of ["demo", "checking", "accountsOff"]) assert.equal(gateTarget(status, "projects"), null);
  assert.equal(holdScreens("checking", true, undefined), true, "a store build shows nothing until it knows");
  assert.equal(holdScreens("checking", false, undefined), false, "a development build stays as it was while the mode loads");
  assert.equal(holdScreens("checking", false, on), true);
  assert.equal(holdScreens("signedIn", true, on), false);
  assert.equal(realSignIn(false, undefined), false);
  assert.equal(realSignIn(false, off), false);
  assert.equal(realSignIn(false, on), true);
  assert.equal(realSignIn(true, undefined), true);
  assert.equal(signInMessage({ data: words.wrongPassword }), words.wrongPassword);
  assert.equal(signInMessage(new TypeError("Network request failed")), words.offline);
  assert.equal(signInMessage(new Error("Failed to fetch")), words.offline);
  assert.equal(signInMessage(new Error("[CONVEX A(auth:signIn)] Server Error")), words.unknown, "a hidden server error is not shown raw");
});

test("the Login screen keeps the demo's controls, adds Apple beside GitHub, and drops Google", () => {
  const login = readFileSync(resolve(root, "app/index.tsx"), "utf8");
  const icons = readFileSync(resolve(root, "components/ui/BrandIcon.tsx"), "utf8");
  const revyl = readFileSync(resolve(root, ".revyl/config.yaml"), "utf8");
  assert.ok(!/google/i.test(login) && !/google/i.test(icons), "no Google button or mark (RC-04, RC-33)");
  assert.ok(!revyl.includes("login-google"));
  for (const id of ['testID="login-enter"', 'testID="login-signup"', "testID={`login-${provider.id}`}", '{ id: "apple"', '{ id: "github"', "<LegalLinks />"]) assert.ok(login.includes(id), id);
  assert.ok(login.indexOf('id: "apple"') < login.indexOf('id: "github"'), "Apple is offered with GitHub, in the same row (RC-16)");
  assert.ok(/apple:\s*"M/.test(icons) && /github:\s*"M/.test(icons));
  const signUp = readFileSync(resolve(root, "app/sign-up.tsx"), "utf8");
  assert.deepEqual([...signUp.matchAll(/<Field label="([^"]+)"/g)].map((match) => match[1]), ["Email", "Password"], "sign-up asks for nothing else (RC-17)");
});

test("every variable sign-in reads has a row, and production refuses the test-only ones", () => {
  const rows = Object.fromEntries(variables.map((row) => [row.name, row]));
  for (const name of ["JWT_PRIVATE_KEY", "JWKS", "SITE_URL", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"]) {
    assert.equal(rows[name]?.production, "required", name);
    assert.equal(rows[name].arrives, undefined, name + " has arrived");
  }
  for (const name of ["AUTH_RESEND_KEY", "AUTH_EMAIL_FROM", "AUTH_APPLE_BUNDLE_ID", "AUTH_SESSION_TOTAL_DURATION_MS", "AUTH_SESSION_INACTIVE_DURATION_MS", "AUTH_LOG_LEVEL", "CUSTOM_AUTH_SITE_URL"]) assert.equal(rows[name]?.production, "optional", name);
  for (const name of ["AUTH_STAND_IN_URL", "AUTH_LOG_SECRETS"]) assert.equal(rows[name]?.production, "never", name);
  for (const name of ["JWT_PRIVATE_KEY", "AUTH_GITHUB_SECRET", "AUTH_RESEND_KEY"]) assert.equal(rows[name].secret, true, name);
  const mine = /AUTH_(GITHUB|RESEND|EMAIL|APPLE|STAND|SESSION|LOG)|JWT_PRIVATE_KEY|JWKS|SITE_URL|convex\/auth|convex\/users/;
  assert.deepEqual(tableProblems(root).filter((problem) => mine.test(problem)), []);
});
