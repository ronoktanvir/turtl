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
const VARIABLES = ["AUTH_REQUIRED", "AUTH_STAND_IN_URL", "AUTH_RESEND_KEY", "AUTH_EMAIL_FROM", "AUTH_APPLE_BUNDLE_ID", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "JWT_PRIVATE_KEY", "JWKS", "SITE_URL"];

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

// Convex Auth's account functions, kept in memory with the same contract: retrieveAccount throws "InvalidAccountId",
// "InvalidSecret" or "TooManyFailedAttempts"; createAccount throws "Account <id> already exists"; a reset code is
// checked by signInViaProvider, which throws "Could not verify code" for a wrong one.
function fakeAuthLibrary() {
  const accounts = [];
  const users = [];
  const sessions = [];
  const invalidated = [];
  const codes = new Map();
  let counter = 0;
  let rateLimited = false;
  const find = (provider, id) => accounts.find((row) => row.provider === provider && row.providerAccountId === id);
  const library = {
    authTables: realAuth.authTables,
    async createAccount(_ctx, { provider, account, profile, shouldLinkViaEmail }) {
      assert.equal(shouldLinkViaEmail, false, "accounts are never linked by email");
      if (find(provider, account.id)) throw new Error(`Account ${account.id} already exists`);
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
        if (rateLimited) throw new Error("TooManyFailedAttempts");
        if (row.secret !== "hashed:" + account.secret) throw new Error("InvalidSecret");
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
        const row = accounts.find((account) => account._id === accountId);
        codes.set(code, row);
        await provider.sendVerificationRequest({ identifier: params.email, token: code });
        return null;
      }
      const row = codes.get(params.code);
      if (!row || row.providerAccountId !== params.email) throw new Error("Could not verify code");
      codes.delete(params.code);
      const sessionId = "authSessions:" + ++counter;
      sessions.push(sessionId);
      return { userId: row.userId, sessionId };
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
    delete: async (id) => {
      for (const list of tables.values()) {
        const index = list.findIndex((row) => row._id === id);
        if (index !== -1) list.splice(index, 1);
      }
    },
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
    query: (table) => ({
      withIndex: (name, build) => {
        const fields = indexes[table]?.[name];
        assert.ok(fields, `${table} has no index ${name}`);
        const conditions = [];
        const range = { eq: (field, value) => (conditions.push([field, value]), range) };
        build(range);
        conditions.forEach(([field], position) => assert.equal(field, fields[position], `${table}.${name} cannot be read by ${field} here`));
        const matched = () => structuredClone(rows(table).filter((row) => conditions.every(([field, value]) => row[field] === value)));
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
    "@convex-dev/auth/providers/Email": { Email: (config) => ({ type: "email", ...config }) },
    lucia: { Scrypt: class { async hash(secret) { return "scrypt:" + secret; } async verify(hash, secret) { return hash === "scrypt:" + secret; } } },
  });
  const { accountTables } = load("convex/auth/schema.ts");
  const store = fakeDb(indexesOf(accountTables));
  const scheduled = [];
  const mutationCtx = { db: store.db, scheduler: { runAt: async (at, fn, args) => void scheduled.push({ at, path: fn.path, args }) } };
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
  const { load, auth, standIn } = await world(t, { AUTH_RESEND_KEY: "stand-in-key", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>" });
  const { words } = load("convex/auth/rules.ts");
  const provider = load("convex/auth/password.ts").password();
  const ctx = {};
  await provider.authorize({ flow: "signUp", email: "owner@example.com", password: "tide pools at dawn" }, ctx);
  assert.equal(await provider.authorize({ flow: "reset", email: "nobody@example.com" }, ctx), null);
  assert.equal(standIn.emails.length, 0, "no email for an address without an account, and the same answer");
  assert.equal(await provider.authorize({ flow: "reset", email: "Owner@example.com" }, ctx), null);
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
});

test("users.mode answers before sign-in; users.viewer returns the signed-in person or null", async (t) => {
  const { load } = await world(t, { AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "secret" });
  const users = load("convex/users.ts");
  assert.deepEqual(await users.mode.handler({}, {}), { accounts: false, github: true, passwordReset: false });
  process.env.AUTH_REQUIRED = "true";
  assert.deepEqual(await users.mode.handler({}, {}), { accounts: true, github: true, passwordReset: false });
  const store = fakeDb(indexesOf(realAuth.authTables));
  const ada = await store.seed("users", { name: "Ada", email: "ada@example.com", image: "https://avatars.example.com/ada.png" });
  await store.seed("authAccounts", { userId: ada, provider: "github", providerAccountId: "4242" });
  await store.seed("authAccounts", { userId: ada, provider: "password", providerAccountId: "ada@example.com", secret: "x" });
  const plain = await store.seed("users", { email: "plain@example.com", image: "http://insecure.example.com/me.png" });
  const as = (subject) => ({ db: store.db, auth: { getUserIdentity: async () => (subject ? { subject } : null) } });
  assert.deepEqual(await users.viewer.handler(as(`${ada}|authSessions:1`), {}), { id: ada, name: "Ada", email: "ada@example.com", picture: "https://avatars.example.com/ada.png", methods: ["password", "github"] });
  assert.deepEqual(await users.viewer.handler(as(`${plain}|authSessions:2`), {}), { id: plain, name: null, email: "plain@example.com", picture: null, methods: [] }, "only an https picture is passed on");
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
        assert.equal(fn.path, "internal.access.account");
        return await access.account.handler({ auth }, args);
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
