import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startAuthStandIn } from "./fixtures/auth-stand-in.mjs";
import { createLoader, memoryDb, root } from "./fixtures/convex-memory.mjs";

// The codes turtl emails, and confirming a new password account's address (second security review, findings 12 and 14,
// and the first review's findings 6 and 7). Each numbered test below performs the attack or the flow behind one
// statement of the brief against the real modules in convex/auth, convex/access.ts and convex/spend, with Convex Auth's
// library replaced by a stand-in that keeps users, accounts, sessions and its wrong-password count in the same
// in-memory database turtl's own functions use, and with every email going to tests/fixtures/auth-stand-in.mjs. Nothing
// here talks to Resend, Apple or GitHub: any other address fails the test.

const VARIABLES = [
  "AUTH_REQUIRED", "AUTH_STAND_IN_URL", "AUTH_RESEND_KEY", "AUTH_EMAIL_FROM", "CONVEX_CLOUD_URL", "SITE_URL",
  "NEW_ACCOUNTS_PER_HOUR", "NEW_ACCOUNTS_PER_DAY", "PASSWORD_SIGNUPS_PER_HOUR", "PASSWORD_SIGNUPS_PER_DAY", "CONFIRMED_SIGNUPS_PER_HOUR", "CONFIRMED_SIGNUPS_PER_DAY",
  "SECRETS_ENCRYPTION_KEY", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG",
];
const MAX_FAILED_PASSWORDS_PER_HOUR = 10;
const realAuth = await import("@convex-dev/auth/server");
const DAY = 24 * 3_600_000;
const START = Date.parse("2026-11-16T00:00:00Z");

// Convex Auth (@convex-dev/auth 0.0.98) as turtl uses it, over the shared database, each call one transaction as the
// library's own mutations are: createAccount makes the users row, calls the afterUserCreatedOrUpdated callback (a throw
// undoes the user), then the account; retrieveAccount counts wrong passwords per account (10 an hour, checked before the
// password, and kept though the sign-in is refused); invalidateSessions deletes sessions. turtl's emailed codes never go
// through the library, so signInViaProvider fails the test.
function fakeConvexAuth(db, mutationCtx, transaction) {
  let config = null;
  const find = (provider, id) => db.query("authAccounts").withIndex("providerAndAccountId", (q) => q.eq("provider", provider).eq("providerAccountId", id)).unique();
  const limitOf = (identifier) => db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", identifier)).unique();
  const left = (row) => Math.min(MAX_FAILED_PASSWORDS_PER_HOUR, row.attemptsLeft + ((Date.now() - row.lastAttemptTime) * MAX_FAILED_PASSWORDS_PER_HOUR) / 3_600_000);
  const created = (provider, type) => async (userId, profile) =>
    await config?.callbacks?.afterUserCreatedOrUpdated?.(mutationCtx, { userId, existingUserId: null, type, provider: { id: provider, type }, profile });
  const library = {
    authTables: realAuth.authTables,
    convexAuth(given) {
      config = given;
      return { auth: {}, signIn: {}, signOut: {}, store: {}, isAuthenticated: {} };
    },
    /** What Convex Auth does when someone signs in with GitHub for the first time (its userOAuth mutation). */
    oauthSignUp: (provider, profile) =>
      transaction(async () => {
        const userId = await db.insert("users", profile);
        await created(provider, "oauth")(userId, profile);
        await db.insert("authAccounts", { userId, provider, providerAccountId: String(profile.id ?? userId) });
        return userId;
      }),
    createAccount: (_ctx, { provider, account, profile, shouldLinkViaEmail }) =>
      transaction(async () => {
        assert.equal(shouldLinkViaEmail, false, "accounts are never linked by email");
        const existing = await find(provider, account.id);
        if (existing) {
          if (account.secret !== undefined && existing.secret !== "hashed:" + account.secret) throw new Error(`Account ${account.id} already exists`);
          return { account: existing, user: await db.get(existing.userId) };
        }
        const userId = await db.insert("users", { ...profile });
        await created(provider, "credentials")(userId, profile);
        const accountId = await db.insert("authAccounts", { userId, provider, providerAccountId: account.id, ...(account.secret !== undefined && { secret: "hashed:" + account.secret }) });
        return { account: await db.get(accountId), user: await db.get(userId) };
      }),
    async retrieveAccount(_ctx, { provider, account }) {
      // The library's mutation answers with a word, so the count it wrote stays; the action then throws it.
      const outcome = await transaction(async () => {
        const row = await find(provider, account.id);
        if (!row) return "InvalidAccountId";
        if (account.secret !== undefined) {
          const limit = await limitOf(row._id);
          if (limit && left(limit) < 1) return "TooManyFailedAttempts";
          if (row.secret !== "hashed:" + account.secret) {
            if (limit) await db.patch(limit._id, { attemptsLeft: left(limit) - 1, lastAttemptTime: Date.now() });
            else await db.insert("authRateLimits", { identifier: row._id, attemptsLeft: MAX_FAILED_PASSWORDS_PER_HOUR - 1, lastAttemptTime: Date.now() });
            return "InvalidSecret";
          }
          if (limit) await db.delete(limit._id);
        }
        return { account: row, user: await db.get(row.userId) };
      });
      if (typeof outcome === "string") throw new Error(outcome);
      return outcome;
    },
    modifyAccountCredentials: (_ctx, { provider, account }) =>
      transaction(async () => {
        const row = await find(provider, account.id);
        if (!row) throw new Error(`Cannot modify account with ID ${account.id} because it does not exist`);
        await db.patch(row._id, { secret: "hashed:" + account.secret });
      }),
    invalidateSessions: (_ctx, { userId, except = [] }) =>
      transaction(async () => {
        for (const session of await db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(100)) {
          if (!except.includes(session._id)) await db.delete(session._id);
        }
      }),
    signInViaProvider: () => assert.fail("turtl's emailed codes never go through Convex Auth's verification codes"),
  };
  return library;
}

// One world per test: fresh modules and database, the email stand-in, and only the variables the test sets. With
// accounts on it runs as a local backend, so the stand-in is honoured; a fetch anywhere else fails the test.
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
  Object.assign(process.env, { AUTH_STAND_IN_URL: standIn.url, CONVEX_CLOUD_URL: "http://127.0.0.1:3210" }, env);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(String(url).startsWith(standIn.url + "/"), "only the stand-in is ever called, not " + url);
    return await realFetch(url, init);
  });
  t.mock.method(console, "error", () => {});

  const schema = createLoader({ "@convex-dev/auth/server": realAuth })("convex/schema.ts").default;
  const db = memoryDb(schema.tables);
  const scheduled = [];
  const scheduler = {
    runAfter: async (delay, fn, args) => void scheduled.push({ at: Date.now() + delay, path: fn.path, args }),
    runAt: async (at, fn, args) => void scheduled.push({ at, path: fn.path, args }),
  };
  // Convex runs one mutation at a time against what the last one wrote (serializable), and a mutation that throws
  // leaves nothing it wrote; so does this world.
  let queue = Promise.resolve();
  const serially = (work) => {
    const transaction = async () => {
      const saved = db.snapshot();
      try {
        return await work();
      } catch (error) {
        db.restore(saved);
        throw error;
      }
    };
    const run = queue.then(transaction, transaction);
    queue = run.catch(() => {});
    return run;
  };
  const mutationCtx = { db, scheduler };
  const library = fakeConvexAuth(db, mutationCtx, serially);
  const load = createLoader({
    "@convex-dev/auth/server": library,
    "@convex-dev/auth/providers/ConvexCredentials": { ConvexCredentials: (config) => ({ type: "credentials", ...config }) },
    lucia: { Scrypt: class { async hash(secret) { return "scrypt:" + secret; } async verify(hash, secret) { return hash === "scrypt:" + secret; } } },
  });
  load("convex/auth.ts");

  const definition = (path) => {
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const found = load("convex/" + segments.join("/") + ".ts")[name];
    assert.ok(found?.handler, "No function " + path);
    return found;
  };
  const auth = (identity) => ({ getUserIdentity: async () => identity ?? null });
  const ctxAs = (identity) => ({ db, scheduler, auth: auth(identity) });
  const actionAs = (identity) => ({
    auth: auth(identity),
    scheduler,
    runQuery: async (fn, args) => {
      const found = definition(fn.path);
      assert.equal(found.kind, "query", fn.path + " is not a query");
      return await found.handler(ctxAs(identity), structuredClone(args));
    },
    runMutation: async (fn, args) => {
      const found = definition(fn.path);
      assert.equal(found.kind, "mutation", fn.path + " is not a mutation");
      return await serially(() => found.handler(ctxAs(identity), structuredClone(args)));
    },
  });
  /** Calls a public or internal function as this identity: "api.auth.confirmation.confirm". */
  const call = async (path, args = {}, identity = null) => {
    const found = definition(path);
    if (found.kind === "action") return await found.handler(actionAs(identity), args);
    if (found.kind === "mutation") return await serially(() => found.handler(ctxAs(identity), structuredClone(args)));
    return await found.handler(ctxAs(identity), structuredClone(args));
  };
  const provider = load("convex/auth/password.ts").password();
  /** The password provider's flows, as the app sends them through auth:signIn. A result with a user is signed in the
   * way the library does it: a new session. */
  const password = async (params) => {
    const result = await provider.authorize(params, actionAs(null));
    if (!result?.userId) return result;
    const sessionId = await db.insert("authSessions", { userId: result.userId, expirationTime: Date.now() + 30 * DAY });
    return { ...result, sessionId, identity: { subject: `${result.userId}|${sessionId}` } };
  };
  const apple = load("convex/auth/apple.ts").apple();
  const signInWithApple = async (sub) => {
    const nonce = randomBytes(32).toString("hex");
    const { createHash } = await import("node:crypto");
    const token = await standIn.signAppleToken({ sub, nonce: createHash("sha256").update(nonce).digest("hex") });
    const result = await apple.authorize({ identityToken: token, nonce }, actionAs(null));
    const sessionId = await db.insert("authSessions", { userId: result.userId, expirationTime: Date.now() + 30 * DAY });
    return { ...result, identity: { subject: `${result.userId}|${sessionId}` } };
  };
  const signInWithGitHub = async (id) => {
    const userId = await library.oauthSignUp("github", { id, name: `octo ${id}`, email: `octo${id}@example.com` });
    const sessionId = await db.insert("authSessions", { userId, expirationTime: Date.now() + 30 * DAY });
    return { userId, identity: { subject: `${userId}|${sessionId}` } };
  };
  const emailsTo = (address) => standIn.emails.filter((email) => email.to?.includes(address));
  return { load, db, standIn, scheduled, call, password, signInWithApple, signInWithGitHub, emailsTo, words: load("convex/auth/rules.ts").words };
}

const ACCOUNTS = { AUTH_REQUIRED: "true", AUTH_RESEND_KEY: "stand-in-key", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>" };
const refusal = (message) => (error) => (error?.data ?? error?.message) === message;
const at = (t, ms) => t.mock.timers.setTime(ms);
/** A well-formed code nobody was sent. */
const guess = () => Array.from(randomBytes(20), (byte) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[byte & 31]).join("");

/** Signs up with a password and confirms the address with the code from the email, as a new owner does. */
async function confirmedOwner(w, email, secret = "tide pools at dawn") {
  const signedUp = await w.password({ flow: "signUp", email, password: secret });
  await w.call("api.auth.confirmation.confirm", { code: w.standIn.lastCode(email) }, signedUp.identity);
  return signedUp;
}

// ---------------------------------------------------------------------------------------------- password reset

test("1. a stranger who knows the owner's address cannot spoil the owner's reset: 1,000 wrong codes leave the owner's code working", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 12 * 3_600_000 });
  const { words } = w;
  await confirmedOwner(w, "owner@example.com");
  const reset = (params) => w.password({ email: "owner@example.com", newPassword: "stranger's pick", ...params, flow: "reset-verification" });
  await w.password({ flow: "reset", email: "owner@example.com" });
  const ownersCode = w.standIn.lastCode("owner@example.com");
  assert.match(ownersCode, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/, "20 characters, about 100 bits");
  // The stranger asks again and again (the code goes to the owner, never to the stranger) and guesses 1,000 times:
  // well-formed codes, the owner's code with one character changed, short codes, digits, nothing.
  for (let n = 0; n < 20; n++) await w.password({ flow: "reset", email: "owner@example.com" });
  const nearMiss = (ownersCode[0] === "A" ? "B" : "A") + ownersCode.slice(1);
  const guesses = [nearMiss, "12345678", "00000000", "", "not a code", ...Array.from({ length: 995 }, guess)];
  for (const code of guesses) await assert.rejects(reset({ code }), refusal(words.wrongCode));
  assert.equal(w.db.rows("authRateLimits").length, 0, "no count of wrong codes exists, for the address or the account");
  assert.equal(w.emailsTo("owner@example.com").length, 2, "the sign-up's confirmation, and one reset: asking again within a minute sends nothing");
  // The owner's code works, pasted however the mail app hands it over.
  const back = await reset({ code: `  ${ownersCode.toLowerCase().replace(/-/g, " ")} `, newPassword: "a new password" });
  assert.ok(back.userId, "the owner is back in");
  assert.ok(await w.password({ flow: "signIn", email: "owner@example.com", password: "a new password" }));
});

test("1. the reviewer's attack replayed: the password kept locked, every new code guessed at at once, and the owner still resets every time", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 12 * 3_600_000 });
  const { words } = w;
  const as = (params) => w.password({ email: "owner@example.com", ...params });
  await confirmedOwner(w, "owner@example.com");
  for (let n = 0; n < 10; n++) await assert.rejects(as({ flow: "signIn", password: `wrong guess ${n}` }), refusal(words.wrongPassword));
  await assert.rejects(as({ flow: "signIn", password: "tide pools at dawn" }), refusal(words.tooManyTries));
  let minute = 0;
  for (let round = 0; round < 4; round++) {
    at(t, START + 12 * 3_600_000 + (minute += 2) * 60_000);
    await assert.rejects(as({ flow: "signIn", password: `keep it locked ${round}` }), (error) => [words.wrongPassword, words.tooManyTries].includes(error?.data));
    await as({ flow: "reset" });
    const ownersCode = w.standIn.lastCode("owner@example.com");
    // The stranger, polling, guesses before the owner types: far more than any count of tries would have allowed.
    for (let n = 0; n < 50; n++) await assert.rejects(as({ flow: "reset-verification", code: guess(), newPassword: "stranger's pick" }), refusal(words.wrongCode));
    const back = await as({ flow: "reset-verification", code: ownersCode, newPassword: `owner's password ${round}` });
    assert.ok(back.userId, `round ${round}: the owner's own code works`);
    // The stranger locks the new password again; the owner is already signed in on this phone.
    for (let n = 0; n < 10; n++) await assert.rejects(as({ flow: "signIn", password: `wrong again ${round}.${n}` }), (error) => [words.wrongPassword, words.tooManyTries].includes(error?.data));
  }
});

test("2. at most five reset emails a day go to one address, and the newest still works until another can be sent", async (t) => {
  const w = await world(t, ACCOUNTS);
  const first = START + 9 * 3_600_000;
  t.mock.timers.enable({ apis: ["Date"], now: first - 3_600_000 });
  const { words } = w;
  const { CODE_EMAILS_PER_DAY, CODE_VALID_HOURS } = w.load("convex/auth/rules.ts");
  assert.equal(CODE_EMAILS_PER_DAY, 5);
  assert.equal(CODE_VALID_HOURS, 24);
  await confirmedOwner(w, "owner@example.com");
  const resets = () => w.emailsTo("owner@example.com").filter((email) => email.subject === "Reset your turtl password");
  // A stranger asks twenty times over the day, two minutes apart from 09:00.
  const codes = [];
  for (let n = 0; n < 20; n++) {
    at(t, first + n * 2 * 60_000);
    await w.password({ flow: "reset", email: "owner@example.com" });
    if (resets().length > codes.length) codes.push(w.standIn.lastCode("owner@example.com"));
  }
  assert.equal(resets().length, 5, "twenty requests, five emails");
  const sentAt = (n) => first + n * 2 * 60_000;
  // Asked for all day long, still five: the window is any 24 hours, not the calendar day.
  for (let hour = 1; hour < 24; hour++) {
    at(t, first + hour * 3_600_000);
    await w.password({ flow: "reset", email: "owner@example.com" });
  }
  assert.equal(resets().length, 5);
  // Just before the first email leaves the window (the moment another may be sent), the newest still works...
  at(t, sentAt(0) + DAY - 1);
  const reset = (code, newPassword) => w.password({ flow: "reset-verification", email: "owner@example.com", code, newPassword });
  assert.ok((await reset(codes[4], "the owner's new password")).userId, "the newest email works until another can be sent");
  // ...and it worked once: every code of the day is used with it.
  await assert.rejects(reset(codes[3], "another password"), refusal(words.wrongCode));
  // Then a new email can go out.
  at(t, sentAt(0) + DAY + 1);
  await w.password({ flow: "reset", email: "owner@example.com" });
  assert.equal(resets().length, 6, "a day after the first, the sixth");
  // A code past its 24 hours never works.
  at(t, sentAt(0) + DAY + 1 + DAY);
  await assert.rejects(reset(w.standIn.lastCode("owner@example.com"), "a late password"), refusal(words.wrongCode), "expired");
});

test("2. a stranger's requests never replace or cancel a code the owner already has", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 8 * 3_600_000 });
  await confirmedOwner(w, "owner@example.com");
  await w.password({ flow: "reset", email: "owner@example.com" });
  const owners = w.standIn.lastCode("owner@example.com");
  for (let n = 1; n <= 30; n++) {
    at(t, START + 8 * 3_600_000 + n * 61_000);
    await w.password({ flow: "reset", email: "owner@example.com" });
  }
  assert.ok((await w.password({ flow: "reset-verification", email: "owner@example.com", code: owners, newPassword: "a new password" })).userId, "the first code still works after four more were sent");
});

test("3. the wrong-password lock cannot keep the owner out: a completed reset clears it, and the new password works at once", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 15 * 3_600_000 });
  const { words } = w;
  const as = (params) => w.password({ email: "owner@example.com", ...params });
  await confirmedOwner(w, "owner@example.com");
  for (let n = 0; n < 25; n++) await assert.rejects(as({ flow: "signIn", password: `wrong ${n}` }), (error) => [words.wrongPassword, words.tooManyTries].includes(error?.data));
  await assert.rejects(as({ flow: "signIn", password: "tide pools at dawn" }), refusal(words.tooManyTries), "Convex Auth's lock, before the password is checked");
  assert.match(words.tooManyTries, /Reset your password to get back in now/, "the refusal points at the way back");
  await as({ flow: "reset" });
  await as({ flow: "reset-verification", code: w.standIn.lastCode("owner@example.com"), newPassword: "a new password" });
  assert.deepEqual(w.db.rows("authRateLimits"), [], "the lock is cleared");
  assert.ok((await as({ flow: "signIn", password: "a new password" })).userId, "on another device, at once");
});

test("4. a reset ends every other session of the account, and a code cannot be redeemed twice, even at the same moment", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 10 * 3_600_000 });
  const { words } = w;
  const owner = await confirmedOwner(w, "owner@example.com");
  const elsewhere = await w.password({ flow: "signIn", email: "owner@example.com", password: "tide pools at dawn" });
  const access = w.load("convex/access.ts");
  const as = (identity) => ({ db: w.db, auth: { getUserIdentity: async () => identity } });
  assert.equal(await access.requireAccount(as(elsewhere.identity)), owner.userId);
  await w.password({ flow: "reset", email: "owner@example.com" });
  const code = w.standIn.lastCode("owner@example.com");
  const redeem = (newPassword) => w.password({ flow: "reset-verification", email: "owner@example.com", code, newPassword });
  // Two redemptions of one code at once (the owner's phone and a stranger who saw the email over a shoulder).
  const outcomes = await Promise.allSettled([redeem("first password"), redeem("second password")]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"], "exactly one works");
  assert.ok(refusal(words.wrongCode)(outcomes.find((outcome) => outcome.status === "rejected").reason));
  const won = outcomes.find((outcome) => outcome.status === "fulfilled").value;
  assert.equal(won.userId, owner.userId);
  // Every session from before is gone; only the one the reset just made is left.
  assert.deepEqual(w.db.rows("authSessions").filter((session) => session.userId === owner.userId).map((session) => session._id), [won.sessionId]);
  for (const before of [owner, elsewhere]) await assert.rejects(access.requireAccount(as(before.identity)), refusal("Sign in to continue."));
  await assert.rejects(redeem("third password"), refusal(words.wrongCode), "a code works once");
});

// ---------------------------------------------------------------------------------------------- confirming the address

test("5. a password account cannot make a project, connect GitHub, store a secret or spend until it confirms its address", async (t) => {
  const w = await world(t, { ...ACCOUNTS, SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
  t.mock.timers.enable({ apis: ["Date"], now: START + 11 * 3_600_000 });
  const { words } = w;
  const signedUp = await w.password({ flow: "signUp", email: "new@example.com", password: "tide pools at dawn" });
  const me = signedUp.identity;
  const [email] = w.emailsTo("new@example.com");
  assert.equal(email.subject, "Confirm your email address for turtl");
  assert.equal((await w.call("api.users.viewer", {}, me)).confirmed, false, "the app shows only Check your email");
  assert.equal((await w.call("api.auth.confirmation.status", {}, me)).email, "new@example.com");
  const { LIST_VERSION } = w.load("convex/consent/services.ts");
  const SIGN_IN = refusal("Sign in to continue.");
  const attempts = {
    "make a project": () => w.call("api.onboarding.projects.add", { repoUrl: "https://github.com/new/shop" }, me),
    "connect GitHub": () => w.call("api.github.connect.finish", { ticket: "a ticket GitHub handed back" }, me),
    "store a coding agent key": () => w.call("api.secrets.account.setCodingAgentKey", { apiKey: "capy_live_0123456789abcdef" }, me),
    "give AI permission": () => w.call("api.consent.permission.allow", { listVersion: LIST_VERSION }, me),
    "register this phone": () => w.call("api.push.devices.register", { token: "ExponentPushToken[new]", platform: "ios" }, me),
    "ask to be deleted (only Start over does that)": () => w.call("api.account.deletion.request", {}, me),
  };
  for (const [what, attempt] of Object.entries(attempts)) await assert.rejects(attempt(), SIGN_IN, what);
  assert.equal(await w.call("internal.access.account", {}, me).catch((error) => error.data), "Sign in to continue.", "what every action asks");
  // Spending: every outbound call asks the gate, which needs an AI permission the account could not give.
  const gate = await w.call("internal.consent.gate.check", { scope: { account: signedUp.userId }, service: "openai", purpose: "send" });
  assert.equal(gate.ok, false);
  assert.deepEqual(w.db.rows("apps"), []);
  assert.deepEqual(w.db.rows("aiConsents"), []);
  // A wrong code does nothing; the code in the email (the link fills it in) confirms.
  await assert.rejects(w.call("api.auth.confirmation.confirm", { code: guess() }, me), refusal(words.wrongCode));
  const link = w.standIn.lastLink("new@example.com");
  assert.match(link, /^turtl:\/\/confirm-email\?code=[0-9A-Z-]{23}$/);
  await w.call("api.auth.confirmation.confirm", { code: new URL(link).searchParams.get("code") }, me);
  assert.equal((await w.call("api.users.viewer", {}, me)).confirmed, true);
  assert.equal(await w.call("api.auth.confirmation.status", {}, me), null);
  assert.ok((await w.call("api.onboarding.projects.add", { repoUrl: "https://github.com/new/shop" }, me)).projectId, "now it can");
  await w.call("api.consent.permission.allow", { listVersion: LIST_VERSION }, me);
  await assert.rejects(w.call("api.github.connect.finish", { ticket: "a ticket GitHub handed back" }, me), (error) => !SIGN_IN(error), "past the account check");
  assert.equal((await w.call("api.secrets.account.setCodingAgentKey", { apiKey: "capy_live_0123456789abcdef" }, me)).setAt > 0, true);
  // A second tap on Confirm, after it worked, is not an error.
  assert.equal(await w.call("api.auth.confirmation.confirm", { code: guess() }, me), null);
});

test("5. accounts made with Sign in with Apple or GitHub count as confirmed", async (t) => {
  const w = await world(t, ACCOUNTS);
  const access = w.load("convex/access.ts");
  const as = (identity) => ({ db: w.db, auth: { getUserIdentity: async () => identity } });
  const apple = await w.signInWithApple("001234.apple-person.0001");
  const github = await w.signInWithGitHub(4242);
  for (const person of [apple, github]) {
    assert.equal(await access.requireAccount(as(person.identity)), person.userId);
    assert.equal((await w.call("api.users.viewer", {}, person.identity)).confirmed, true);
  }
  assert.deepEqual(w.db.rows("authUnconfirmed"), []);
  assert.equal(w.standIn.emails.length, 0, "no email to confirm");
});

test("5. with accounts on and no email service, there is no password sign-up, since the code could not be sent", async (t) => {
  const w = await world(t, { AUTH_REQUIRED: "true" });
  await assert.rejects(w.password({ flow: "signUp", email: "new@example.com", password: "tide pools at dawn" }), refusal(w.words.signUpOff));
  assert.deepEqual(w.db.rows("users"), []);
});

test("6. throwaway password sign-ups cannot use up the room for Apple, GitHub or confirmed accounts", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 30 * 60_000 });
  const limits = w.load("convex/spend/limits.ts");
  const { ceilingRefusal } = limits;
  assert.deepEqual(
    [limits.passwordSignUpsPerHour(), limits.passwordSignUpsPerDay(), limits.confirmedSignUpsPerHour(), limits.confirmedSignUpsPerDay(), limits.newAccountsPerHour(), limits.newAccountsPerDay()],
    [40, 200, 20, 100, 20, 100],
    "the default ceilings",
  );
  // A real person signs up first and does not confirm yet.
  const real = await w.password({ flow: "signUp", email: "real@example.com", password: "tide pools at dawn" });
  // A script makes throwaway accounts all day, as fast as it is let, and never confirms one.
  let made = 1;
  let refusedThisHour = 0;
  for (let hour = 0; hour < 24 && made < 200; hour++) {
    at(t, START + hour * 3_600_000 + 30 * 60_000);
    for (let n = 0; n < 45; n++) {
      try {
        await w.password({ flow: "signUp", email: `throwaway-${hour}-${n}@example.com`, password: "throwaway pass" });
        made += 1;
      } catch (error) {
        assert.ok(refusal(ceilingRefusal.passwordSignUpsThisHour)(error) || refusal(ceilingRefusal.passwordSignUpsToday)(error), error?.data);
        refusedThisHour += 1;
      }
    }
  }
  assert.equal(made, 200, "the day's password sign-ups are spent");
  assert.ok(refusedThisHour > 0);
  at(t, START + 20 * 3_600_000);
  await assert.rejects(w.password({ flow: "signUp", email: "late@example.com", password: "tide pools at dawn" }), refusal(ceilingRefusal.passwordSignUpsToday));
  assert.match(ceilingRefusal.passwordSignUpsToday, /sign up with Apple or GitHub/);
  // Apple and GitHub sign-ups, and the real person confirming, are still let in.
  const apple = await w.signInWithApple("001234.after-the-script.0001");
  const github = await w.signInWithGitHub(5151);
  assert.ok(apple.userId && github.userId);
  await w.call("api.auth.confirmation.confirm", { code: w.standIn.lastCode("real@example.com") }, real.identity);
  assert.equal((await w.call("api.users.viewer", {}, real.identity)).confirmed, true);
  const totals = Object.fromEntries(w.db.rows("deploymentTotals").map((row) => [row.name, row.value]));
  assert.equal(totals.password_signups_day, 200);
  assert.equal(totals.accounts_day, 2, "Apple and GitHub counted apart");
  assert.equal(totals.confirmations_day, 1, "confirmations counted apart");
});

test("6. each ceiling refuses in plain words and undoes what it refused; a refused confirmation leaves its code working", async (t) => {
  const w = await world(t, { ...ACCOUNTS, CONFIRMED_SIGNUPS_PER_HOUR: "1", NEW_ACCOUNTS_PER_HOUR: "1" });
  t.mock.timers.enable({ apis: ["Date"], now: START + 10 * 3_600_000 });
  const { ceilingRefusal } = w.load("convex/spend/limits.ts");
  const one = await w.password({ flow: "signUp", email: "one@example.com", password: "tide pools at dawn" });
  const two = await w.password({ flow: "signUp", email: "two@example.com", password: "tide pools at dawn" });
  await w.call("api.auth.confirmation.confirm", { code: w.standIn.lastCode("one@example.com") }, one.identity);
  const code = w.standIn.lastCode("two@example.com");
  await assert.rejects(w.call("api.auth.confirmation.confirm", { code }, two.identity), refusal(ceilingRefusal.confirmationsThisHour));
  assert.equal((await w.call("api.users.viewer", {}, two.identity)).confirmed, false);
  at(t, START + 11 * 3_600_000);
  await w.call("api.auth.confirmation.confirm", { code }, two.identity);
  assert.equal((await w.call("api.users.viewer", {}, two.identity)).confirmed, true, "the same code, an hour later");
  await w.signInWithApple("001234.first.0001");
  await assert.rejects(w.signInWithApple("001234.second.0001"), refusal(ceilingRefusal.accountsThisHour));
  assert.equal(w.db.rows("users").length, 3, "the refused Apple sign-up left no user");
});

test("7. confirmation emails are limited per address per day, and a stranger who took the address cannot spoil its codes", async (t) => {
  const w = await world(t, ACCOUNTS);
  let now = START + 14 * 3_600_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const { words } = w;
  const later = (ms) => at(t, (now += ms));
  // Mallory signs up with Alice's address, asks for the email again and again, and guesses at the code.
  let mallory = await w.password({ flow: "signUp", email: "alice@example.com", password: "mallory's pass" });
  const answers = [];
  for (let n = 0; n < 8; n++) {
    later(2 * 60_000);
    answers.push(await w.call("api.auth.confirmation.resend", {}, mallory.identity));
  }
  assert.deepEqual(answers.map((answer) => answer.sent), [true, true, true, true, false, false, false, false], "five emails in all, the sign-up's included");
  assert.match(answers.at(-1).message, /The newest one still works/);
  later(10_000);
  assert.equal((await w.call("api.auth.confirmation.resend", {}, mallory.identity)).sent, false);
  for (let n = 0; n < 200; n++) await assert.rejects(w.call("api.auth.confirmation.confirm", { code: guess() }, mallory.identity), refusal(words.wrongCode));
  // Throwing the account away and signing up again does not reset the address's limit.
  await w.call("api.auth.confirmation.startOver", {}, mallory.identity);
  later(60_000);
  mallory = await w.password({ flow: "signUp", email: "alice@example.com", password: "mallory's pass" });
  assert.equal(w.emailsTo("alice@example.com").length, 5, "still five");
  // Alice, who only has her inbox: "There's already an account", so she resets the password and gets in...
  await assert.rejects(w.password({ flow: "signUp", email: "alice@example.com", password: "alice's own pass" }), refusal(words.accountExists));
  await w.password({ flow: "reset", email: "alice@example.com" });
  const alice = await w.password({ flow: "reset-verification", email: "alice@example.com", code: w.standIn.lastCode("alice@example.com"), newPassword: "alice's own pass" });
  const access = w.load("convex/access.ts");
  await assert.rejects(access.requireAccount({ db: w.db, auth: { getUserIdentity: async () => mallory.identity } }), refusal("Sign in to continue."), "Mallory is signed out");
  // ...and confirms with a code from her inbox: one Mallory made turtl send, after all of Mallory's guesses.
  const inbox = w.emailsTo("alice@example.com").filter((email) => email.subject === "Confirm your email address for turtl");
  const code = inbox.at(-1).text.match(/^([0-9A-Z]{5}(?:-[0-9A-Z]{5}){3})$/m)[1];
  await w.call("api.auth.confirmation.confirm", { code }, alice.identity);
  assert.equal((await w.call("api.users.viewer", {}, alice.identity)).confirmed, true);
});

test("8. an account that never confirms is deleted seven days after sign-up; Start over deletes one at once", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const left = await w.password({ flow: "signUp", email: "left@example.com", password: "tide pools at dawn" });
  const confirmed = await confirmedOwner(w, "kept@example.com");
  at(t, START + 6 * DAY);
  assert.equal(await w.call("internal.auth.confirmation.sweep"), 0, "not yet");
  at(t, START + 7 * DAY + 3_600_000);
  assert.equal(await w.call("internal.auth.confirmation.sweep"), 1);
  const [deletion] = w.db.rows("accountDeletions");
  assert.equal(deletion.account, left.userId, "account deletion's job, which removes everything (convex/account)");
  assert.ok(w.scheduled.some((job) => job.path === "internal.account.deletion.run"));
  assert.ok(w.db.rows("authSessions").filter((session) => session.userId === left.userId).every((session) => session.expirationTime === 0), "its sessions ended");
  assert.deepEqual(w.db.rows("authAccounts").filter((row) => row.userId === left.userId), [], "its address is free at once");
  assert.ok(w.db.rows("authAccounts").some((row) => row.userId === confirmed.userId), "a confirmed account is never swept");
  const { accountErasers } = w.load("convex/account/registry.ts");
  assert.ok(accountErasers.some((entry) => entry.table === "authUnconfirmed"), "the job removes the hold with the account");
  assert.equal(await w.call("internal.auth.confirmation.sweep"), 1, "a second sweep finds the same deletion, and starts nothing new");
  assert.equal(w.db.rows("accountDeletions").length, 1);
  // Start over: the wrong address, thrown away by its owner, and the address free for anyone.
  const typo = await w.password({ flow: "signUp", email: "owner@exmaple.com", password: "tide pools at dawn" });
  await w.call("api.auth.confirmation.startOver", {}, typo.identity);
  assert.deepEqual(w.db.rows("authAccounts").filter((row) => row.userId === typo.userId), []);
  await assert.rejects(w.call("api.auth.confirmation.startOver", {}, confirmed.identity), refusal("Sign in to continue."), "a confirmed account cannot be thrown away like this");
});

test("9. the operator confirms one account from the command line; the review account is confirmed when it is made", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START + 10 * 3_600_000 });
  const waiting = await w.password({ flow: "signUp", email: "Someone@Example.com", password: "tide pools at dawn" });
  assert.deepEqual(await w.call("internal.auth.confirmation.markConfirmed", { email: " someone@example.COM " }), { email: "someone@example.com", wasWaiting: true });
  assert.equal((await w.call("api.users.viewer", {}, waiting.identity)).confirmed, true);
  await assert.rejects(w.call("internal.auth.confirmation.markConfirmed", { email: "nobody@example.com" }), refusal("There's no account with a password for nobody@example.com."));
  // The App Review account: made and confirmed in one command, with no email needed.
  const logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, level, (...args) => logged.push(args.join(" ")));
  const { ensureAccount } = w.load("convex/auth/review.ts");
  const review = (args) => ensureAccount.handler({ runMutation: (fn, a) => w.call(fn.path, a) }, args);
  assert.deepEqual(await review({ email: "Review@Example.com", password: "review pass one" }), { email: "review@example.com", created: true });
  const reviewer = await w.password({ flow: "signIn", email: "review@example.com", password: "review pass one" });
  assert.equal((await w.call("api.users.viewer", {}, reviewer.identity)).confirmed, true);
  assert.equal(w.emailsTo("review@example.com").length, 0, "no email to the review address");
  assert.deepEqual(await review({ email: "review@example.com", password: "review pass two" }), { email: "review@example.com", created: false });
  assert.ok((await w.password({ flow: "signIn", email: "review@example.com", password: "review pass two" })).userId);
  assert.equal(w.db.rows("users").filter((user) => user.email === "review@example.com").length, 1);
  assert.equal((await w.call("api.users.viewer", {}, reviewer.identity)).confirmed, true, "a reviewer already signed in stays signed in");
  await assert.rejects(review({ email: "review@example.com", password: "short" }), /Choose a password/);
  await assert.rejects(review({ email: "review", password: "review pass three" }), /Enter your email/);
  assert.ok(logged.every((line) => !line.includes("review pass")), "no password in any log line");
  assert.equal(w.db.rows("deploymentTotals").find((row) => row.name === "confirmations_day"), undefined, "the operator's confirmations count against no ceiling");
});

test("10. accounts made before confirmation existed count as confirmed", async (t) => {
  const w = await world(t, ACCOUNTS);
  const userId = await w.db.insert("users", { email: "early@example.com" });
  await w.db.insert("authAccounts", { userId, provider: "password", providerAccountId: "early@example.com", secret: "hashed:tide pools at dawn" });
  const early = await w.password({ flow: "signIn", email: "early@example.com", password: "tide pools at dawn" });
  const access = w.load("convex/access.ts");
  assert.equal(await access.requireAccount({ db: w.db, auth: { getUserIdentity: async () => early.identity } }), userId);
  assert.equal((await w.call("api.users.viewer", {}, early.identity)).confirmed, true);
  assert.equal(await w.call("internal.auth.confirmation.sweep"), 0, "nothing to sweep");
});

test("the single-owner demo is unchanged: no hold, no email, nothing read", async (t) => {
  const w = await world(t, { AUTH_RESEND_KEY: "stand-in-key", AUTH_EMAIL_FROM: "turtl <no-reply@example.com>", CONVEX_CLOUD_URL: undefined });
  const signedUp = await w.password({ flow: "signUp", email: "demo@example.com", password: "tide pools at dawn" });
  assert.deepEqual(w.db.rows("authUnconfirmed"), []);
  assert.equal(w.standIn.emails.length, 0, "no confirmation email in the demo");
  const access = w.load("convex/access.ts");
  const ctx = { db: w.db, auth: { getUserIdentity: async () => signedUp.identity } };
  w.db.reads.length = 0;
  assert.equal(await access.requireAccount(ctx), "solo-owner");
  assert.equal(await access.pendingAccount(ctx), null);
  await access.signedInAccount(ctx);
  assert.ok(!w.db.reads.some(([, table]) => table === "authUnconfirmed"), "the demo never reads the hold");
  assert.equal(await w.call("api.auth.confirmation.status", {}, signedUp.identity), null);
  assert.equal(await w.call("internal.auth.confirmation.sweep"), 0);
  assert.deepEqual(w.db.rows("deploymentTotals"), [], "and counts nothing");
});

// ---------------------------------------------------------------------------------------------- the emails and the codes

test("the emails are short and plain, say what to do and that they can be ignored, carry a link and the code, and never a password", async (t) => {
  const w = await world(t, ACCOUNTS);
  const email = w.load("convex/auth/email.ts");
  const { normalizeCode, formatCode, CODE_ALPHABET } = w.load("convex/auth/rules.ts");
  const code = "ABCDE0123456789FGHJK";
  const reset = email.resetMessage("o'neil+test@example.com", code);
  const confirm = email.confirmMessage("o'neil+test@example.com", code);
  assert.equal(reset.subject, "Reset your turtl password");
  assert.equal(confirm.subject, "Confirm your email address for turtl");
  for (const message of [reset, confirm]) {
    assert.ok(!message.subject.includes(code), "no code where a lock screen shows it");
    assert.ok(message.text.includes(formatCode(code)) && message.html.includes(formatCode(code)));
    assert.match(message.text, /ignore this email/);
    assert.match(message.text, /24 hours/);
    assert.ok(!/password:|your password is/i.test(message.text), "never a password");
    assert.ok(message.text.split(/\s+/).length < 110, "short");
    assert.ok(!/<script|<img|<style|https?:\/\//i.test(message.html), "nothing but paragraphs and the turtl:// link");
  }
  assert.match(reset.text, /turtl:\/\/reset-password\?email=o'neil%2Btest%40example\.com&code=ABCDE-01234-56789-FGHJK/);
  assert.match(reset.html, /href="turtl:\/\/reset-password\?email=o&#39;neil%2Btest%40example\.com&#38;code=ABCDE-01234-56789-FGHJK"/, "escaped in HTML");
  assert.match(confirm.text, /turtl:\/\/confirm-email\?code=ABCDE-01234-56789-FGHJK/);
  assert.match(confirm.text, /deletes it after 7 days/);
  // Codes: twenty from the alphabet, varied; pasted any way they come.
  const { randomCode } = w.load("convex/auth/codes.ts");
  const codes = Array.from({ length: 200 }, randomCode);
  assert.ok(codes.every((made) => made.length === 20 && [...made].every((character) => CODE_ALPHABET.includes(character))));
  assert.equal(new Set(codes).size, 200);
  assert.equal(normalizeCode(" abcde-01234 56789_fghjk "), code);
  assert.equal(normalizeCode("abcde-o1234-56789-fghjk"), code, "O read as zero");
  assert.equal(normalizeCode("ABCDE-0I234-56789-FGHJK"), code, "I read as one");
  assert.equal(normalizeCode("ABCDE-0l234-56789-FGHJK"), code, "l read as one");
  for (const bad of ["", "ABCDE", code + "A", "ABCDE-01234-56789-FGHJU", 42, null]) assert.equal(normalizeCode(bad), null, String(bad));
});

test("a refused send takes its code back, so it neither works nor counts, and the log holds only the status", async (t) => {
  const w = await world(t, ACCOUNTS);
  const { emailCode } = w.load("convex/auth/email.ts");
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const ctx = { runMutation: (fn, args) => w.call(fn.path, args) };
  const refused = async () => new Response("owner@example.com is not allowed", { status: 403 });
  await assert.rejects(emailCode(ctx, "owner@example.com", "reset", refused), refusal(w.words.emailNotSent));
  assert.deepEqual(logged, ["turtl's email was not accepted (HTTP 403)."]);
  assert.deepEqual(w.db.rows("authEmailCodes"), []);
  assert.deepEqual(await emailCode(ctx, "owner@example.com", "reset"), { ok: true }, "and the next one goes out at once");
  const [row] = w.db.rows("authEmailCodes");
  assert.equal(row.addressHash.length, 64);
  assert.ok(!JSON.stringify(row).includes("owner@example.com") && !JSON.stringify(row).includes(w.standIn.lastCode().replace(/-/g, "")), "only hashes are kept");
  // A key without a sender is no email service: reset says so, and a password sign-up is refused.
  delete process.env.AUTH_EMAIL_FROM;
  assert.equal(w.load("convex/auth/settings.ts").emailService(), null);
  await assert.rejects(w.password({ flow: "reset", email: "owner@example.com" }), refusal(w.words.resetOff));
  await assert.rejects(w.password({ flow: "signUp", email: "new@example.com", password: "tide pools at dawn" }), refusal(w.words.signUpOff));
});

test("emailed codes are forgotten a day after they were sent", async (t) => {
  const w = await world(t, ACCOUNTS);
  t.mock.timers.enable({ apis: ["Date"], now: START });
  await w.password({ flow: "signUp", email: "one@example.com", password: "tide pools at dawn" });
  at(t, START + DAY - 1);
  assert.equal(await w.call("internal.auth.codes.prune"), 0);
  at(t, START + DAY + 1);
  assert.equal(await w.call("internal.auth.codes.prune"), 1);
  assert.deepEqual(w.db.rows("authEmailCodes"), []);
});
