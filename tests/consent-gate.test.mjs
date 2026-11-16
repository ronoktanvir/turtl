import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createLoader, memoryDb, root, withEnv } from "./fixtures/convex-memory.mjs";

// The AI permission (RC-26): the list comes from store/data-practices.json, nothing reaches OpenAI, Supermemory,
// Capy or Keiki for an account that has not said yes, taking it back stops the next call, and a changed list asks
// again. The demo (AUTH_REQUIRED unset) is untouched. Everything here runs against stand-ins: no vendor is called.

const practices = JSON.parse(readFileSync(join(root, "store/data-practices.json"), "utf8"));
const load = createLoader();
const services = load("convex/consent/services.ts");
const gates = load("convex/consent/gate.ts");
const permission = load("convex/consent/permission.ts");
const outbound = load("convex/consent/outbound.ts");
const { consentTables } = load("convex/consent/schema.ts");
const { spendTables } = load("convex/spend/schema.ts");

const ACCOUNTS = { AUTH_REQUIRED: "true", MODEL_SPEND_LIMIT_USD: undefined, CODING_THREADS_PER_DAY: undefined };
const DEMO = { AUTH_REQUIRED: undefined };
const ADA = "acct-ada";
const REASON = "you have not said yet whether turtl may send anything to OpenAI, so nothing was sent (you can allow it in Settings)";

const allowedRow = (overrides = {}) => ({
  account: ADA,
  answer: "allowed",
  services: services.ASKED.map((service) => ({ id: service.id, version: service.version })),
  listVersion: services.LIST_VERSION,
  answeredAt: 1,
  ...overrides,
});

function world(seed = {}) {
  return memoryDb(
    { ...consentTables, ...spendTables, apps: null, cases: null },
    {
      apps: [{ _id: "apps:1", name: "Booking", ownerId: ADA }, { _id: "apps:2", name: "No owner" }, { _id: "apps:3", name: "Bob's", ownerId: "acct-bob" }],
      cases: [{ _id: "cases:1", appId: "apps:1", title: "Bookings fail" }],
      ...seed,
    },
  );
}

const signedIn = (account) => ({ getUserIdentity: async () => (account ? { subject: `${account}|session-1` } : null) });
const check = (db, scope, service, purpose = "send") => gates.check.handler({ db }, { scope, service, purpose });
const untouchable = new Proxy({}, { get: (_target, key) => assert.fail(`the demo read the database (${String(key)})`) });

test("the screen's list is store/data-practices.json's, imported and not copied", () => {
  const asked = practices.services.filter((service) => service.needsPermission);
  assert.deepEqual(services.ASKED.map((service) => service.id), ["openai", "supermemory", "capy", "keiki"]);
  assert.deepEqual(
    services.ASKED.map(({ id, name, does, receives, policy }) => ({ id, name, does, receives, policy })),
    asked.map(({ id, name, does, receives, policy }) => ({ id, name, does, receives, policy })),
  );
  assert.deepEqual(services.ALSO_USED.map((service) => service.id), ["convex", "github", "revyl", "expo", "resend", "apple"]);
  assert.match(services.LIST_VERSION, /^[0-9a-f]{8}$/);
  const source = readFileSync(join(root, "convex/consent/services.ts"), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/store\/data-practices\.json"/);
  for (const service of asked) assert.ok(!source.includes(service.does), `services.ts copies what ${service.name} does`);
});

test("a yes covers exactly the services, and the version of each, that were on the screen", () => {
  const agreement = { answer: "allowed", services: services.ASKED.map(({ id, version }) => ({ id, version })), listVersion: services.LIST_VERSION };
  for (const { id } of services.ASKED) assert.deepEqual(services.permissionFor(agreement, id), { ok: true });
  const refused = (value, service = "openai") => {
    const answer = services.permissionFor(value, service);
    assert.equal(answer.ok, false);
    return answer.reason;
  };
  assert.equal(refused(null), REASON);
  assert.match(refused({ ...agreement, answer: "declined", services: [] }), /^you chose not to let turtl send anything to OpenAI, so nothing was sent/);
  assert.match(refused({ ...agreement, withdrawnAt: 5 }), /^you took back turtl's permission to send anything to OpenAI/);
  assert.match(refused({ ...agreement, services: agreement.services.filter((s) => s.id !== "keiki") }, "keiki"), /^turtl added Keiki to its list after you answered/);
  assert.match(refused({ ...agreement, services: agreement.services.map((s) => (s.id === "openai" ? { ...s, version: "00000000" } : s)) }), /^what turtl sends to OpenAI changed after you agreed/);
  assert.equal(refused(agreement, "anthropic"), "turtl has not asked you about Anthropic, so nothing was sent to it");
  assert.equal(refused(agreement, "google"), "turtl has not asked you about Google, so nothing was sent to it");
  assert.deepEqual(services.standingOf(null), { answer: "none", allowed: [], needsAnswer: true });
  assert.deepEqual(services.standingOf(agreement), { answer: "allowed", allowed: ["openai", "supermemory", "capy", "keiki"], needsAnswer: false });
  assert.equal(services.standingOf({ ...agreement, listVersion: "00000000" }).needsAnswer, true, "adding a service later asks again");
  assert.deepEqual(services.standingOf({ ...agreement, withdrawnAt: 9 }), { answer: "withdrawn", allowed: [], needsAnswer: false });
});

// Review finding 20: the demo's yes holds only on a deployment that holds no account, so the gate reads that (the four
// empty ranges of demoHoldsAccounts in convex/access.ts) and nothing else, and writes nothing.
test("in the demo the gate says yes after one look that the deployment holds no account, and writes nothing", async () => {
  await withEnv(DEMO, async () => {
    const db = world({ apps: [{ _id: "apps:1", name: "Booking", ownerId: "solo-owner" }], cases: [] });
    assert.deepEqual(await gates.check.handler({ db }, { scope: { appId: "apps:1" }, service: "anthropic", purpose: "send" }), { ok: true, account: "solo-owner" });
    assert.deepEqual(db.reads, [["first", "authAccounts"], ["first", "users"], ["index", "apps", "by_owner"], ["index", "apps", "by_owner"]], "only whether it holds accounts");
    const asked = [];
    const ctx = { runQuery: async (fn, args) => (asked.push(fn.path), await gates.check.handler({ db }, args)), runMutation: () => assert.fail("the demo wrote spend") };
    const gate = gates.gateFor(ctx, { appId: "apps:1" });
    for (const service of ["openai", "supermemory", "capy", "keiki", "anthropic", "google"]) {
      assert.equal(await gate.blocked(service), null);
      assert.equal((await gate.open(service)).ok, true);
    }
    assert.equal(await gate.blocked("capy", "start_thread"), null);
    assert.ok(asked.every((path) => path === "internal.consent.gate.check"));
    await gate.spent(3);
    await gate.threadStarted("request-1");
  });
});

test("in accounts mode nothing is sent until the owner says yes, and taking it back stops the next call", async () => {
  await withEnv(ACCOUNTS, async () => {
    const db = world();
    for (const service of ["openai", "supermemory", "capy", "keiki"]) {
      const answer = await check(db, { appId: "apps:1" }, service);
      assert.equal(answer.ok, false, service);
      assert.match(answer.reason, /^you have not said yet whether turtl may send anything to /);
    }
    const ctx = { db, auth: signedIn(ADA) };
    await permission.allow.handler(ctx, { listVersion: services.LIST_VERSION });
    for (const service of ["openai", "supermemory", "capy", "keiki"]) assert.deepEqual(await check(db, { appId: "apps:1" }, service), { ok: true, account: ADA });
    for (const service of ["anthropic", "google"]) assert.match((await check(db, { appId: "apps:1" }, service)).reason, /^turtl has not asked you about /);

    await permission.withdraw.handler(ctx, {});
    const withdrawn = await check(db, { caseId: "cases:1" }, "openai");
    assert.deepEqual(withdrawn, { ok: false, reason: "you took back turtl's permission to send anything to OpenAI, so nothing was sent (you can allow it again in Settings)" });
    assert.equal(typeof db.rows("aiConsents")[0].withdrawnAt, "number", "the row records when it was taken back");

    await permission.allow.handler(ctx, { listVersion: services.LIST_VERSION });
    assert.equal((await check(db, { caseId: "cases:1" }, "openai")).ok, true, "allowing again takes effect at once");
    assert.equal(db.rows("aiConsents").length, 2, "each answer is kept, the newest is in force");
    await permission.decline.handler(ctx, { listVersion: services.LIST_VERSION });
    assert.match((await check(db, { appId: "apps:1" }, "supermemory")).reason, /^you chose not to let turtl send anything to Supermemory/);
  });
});

test("the owner is read from the project, never from whoever is calling", async () => {
  await withEnv(ACCOUNTS, async () => {
    const db = world({ aiConsents: [{ _id: "aiConsents:1", ...allowedRow({ account: "acct-bob" }) }] });
    assert.match((await check(db, { appId: "apps:1" }, "openai")).reason, /^you have not said yet/, "Bob's yes does not cover Ada's project");
    assert.deepEqual(await check(db, { appId: "apps:3" }, "openai"), { ok: true, account: "acct-bob" });
    assert.deepEqual(await check(db, { appId: "apps:2" }, "openai"), { ok: false, reason: "turtl could not tell whose project this is, so nothing was sent to OpenAI" });
    assert.deepEqual(await check(db, { appId: "not-an-id" }, "openai"), { ok: false, reason: "turtl could not tell whose project this is, so nothing was sent to OpenAI" });
    assert.deepEqual(await check(db, { account: "acct-bob" }, "keiki"), { ok: true, account: "acct-bob" });
    assert.deepEqual(await check(db, { appId: "apps:2" }, "supermemory", "erase"), { ok: true, account: "" }, "deleting a copy needs no permission");
  });
});

test("a list that changed after the answer asks again, and a stale yes is refused", async () => {
  await withEnv(ACCOUNTS, async () => {
    const stale = allowedRow({ listVersion: "00000000", services: allowedRow().services.map((s) => (s.id === "openai" ? { ...s, version: "00000000" } : s)) });
    const db = world({ aiConsents: [{ _id: "aiConsents:1", ...stale }] });
    assert.match((await check(db, { appId: "apps:1" }, "openai")).reason, /^what turtl sends to OpenAI changed after you agreed/);
    assert.equal((await check(db, { appId: "apps:1" }, "capy")).ok, true, "services whose terms did not change stay allowed");
    const status = await permission.status.handler({ db, auth: signedIn(ADA) }, {});
    assert.equal(status.needsAnswer, true);
    await assert.rejects(permission.allow.handler({ db, auth: signedIn(ADA) }, { listVersion: "00000000" }), (error) => error.data === permission.LIST_CHANGED);
  });
});

test("the status tells the app whether to ask, and never asks in the demo or before sign-in", async () => {
  await withEnv(DEMO, async () => {
    // A demo deployment: its projects are the one owner's (one another account owned would close the demo).
    const status = await permission.status.handler({ db: world({ apps: [{ _id: "apps:1", name: "Booking", ownerId: "solo-owner" }] }), auth: signedIn(null) }, {});
    assert.deepEqual([status.enforced, status.needsAnswer], [false, false]);
    assert.equal(status.services.length, 4);
  });
  await withEnv(ACCOUNTS, async () => {
    const db = world();
    const signedOut = await permission.status.handler({ db, auth: signedIn(null) }, {});
    assert.deepEqual([signedOut.enforced, signedOut.signedIn, signedOut.needsAnswer], [true, false, false]);
    const fresh = await permission.status.handler({ db, auth: signedIn(ADA) }, {});
    assert.deepEqual([fresh.answer, fresh.needsAnswer, fresh.listVersion], ["none", true, services.LIST_VERSION]);
    assert.deepEqual(fresh.services.map((service) => [service.id, service.allowed]), [["openai", false], ["supermemory", false], ["capy", false], ["keiki", false]]);
    assert.deepEqual(fresh.services[0].receives, practices.services.find((service) => service.id === "openai").receives);
    await permission.allow.handler({ db, auth: signedIn(ADA) }, { listVersion: services.LIST_VERSION });
    const allowed = await permission.status.handler({ db, auth: signedIn(ADA) }, {});
    assert.deepEqual([allowed.answer, allowed.needsAnswer, allowed.services.every((service) => service.allowed)], ["allowed", false, true]);
    await permission.withdraw.handler({ db, auth: signedIn(ADA) }, {});
    const withdrawn = await permission.status.handler({ db, auth: signedIn(ADA) }, {});
    assert.deepEqual([withdrawn.answer, withdrawn.needsAnswer, withdrawn.services.some((service) => service.allowed)], ["withdrawn", false, false]);
    assert.equal(typeof withdrawn.withdrawnAt, "number");
    await assert.rejects(permission.allow.handler({ db, auth: signedIn(null) }, { listVersion: services.LIST_VERSION }), (error) => error.data === "Sign in to continue.");
  });
});

test("the action-side gate asks on every call in accounts mode, and records spend only after a yes", async () => {
  await withEnv(ACCOUNTS, async () => {
    const asked = [];
    const wrote = [];
    let answer = { ok: true, account: ADA };
    // A model call about to be sent is admitted (asked and counted at once, convex/spend), so it is a mutation.
    const ctx = {
      runQuery: async (fn, args) => (asked.push([fn.path, args]), answer),
      runMutation: async (fn, args) => (fn.path === "internal.consent.gate.admit" ? (asked.push([fn.path, args]), answer) : void wrote.push([fn.path, args])),
    };
    const gate = gates.gateFor(ctx, { caseId: "cases:1" });
    assert.equal(await gate.blocked("openai"), null);
    assert.equal(typeof (await gate.open("openai")).fetch, "function");
    await gate.spent(0.25);
    await gate.spent(0);
    await gate.threadStarted("turtl:fix-1");
    assert.deepEqual(asked.map(([path, args]) => [path, args.service, args.purpose]), [
      ["internal.consent.gate.check", "openai", "send"],
      ["internal.consent.gate.admit", "openai", "send"],
    ]);
    assert.deepEqual(asked[0][1].scope, { caseId: "cases:1" });
    assert.deepEqual(wrote, [
      ["internal.spend.ledger.addModelSpend", { account: ADA, costUsd: 0.25 }],
      ["internal.spend.ledger.recordThread", { account: ADA, requestId: "turtl:fix-1" }],
    ]);
    answer = { ok: false, reason: REASON };
    assert.equal(await gate.blocked("openai"), REASON);
    assert.deepEqual(await gate.open("openai"), { ok: false, reason: REASON });
    assert.equal((await gate.open("supermemory", "erase")).ok, true, "a delete is not asked about");
    assert.equal(asked.length, 4);
  });
});

test("a request opened for one service cannot be addressed to another", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (input) => (seen.push(String(input)), new Response("{}")));
  await assert.rejects(outbound.sendTo("openai")("https://api.capy.ai/api/v1/threads"), /A request for OpenAI was addressed to Capy, so it was not sent/);
  await assert.rejects(outbound.sendTo("capy")("https://api.openai.com/v1/responses"), /addressed to OpenAI/);
  await outbound.sendTo("keiki")("http://localhost:9999/stand-in");
  await outbound.sendTo("openai")("https://api.openai.com/v1/chat/completions");
  assert.deepEqual(seen, ["http://localhost:9999/stand-in", "https://api.openai.com/v1/chat/completions"]);
});

// A gate that refuses everything except a delete, and one that allows everything through a recording fetch.
function deniedGate(fetchSpy) {
  return {
    blocked: async () => REASON,
    open: async (_service, purpose) => (purpose === "erase" ? { ok: true, fetch: fetchSpy } : { ok: false, reason: REASON }),
    spent: async () => assert.fail("nothing was sent, so nothing was spent"),
    threadStarted: async () => assert.fail("no thread was started"),
  };
}
function allowedGate(respond) {
  const sent = [];
  const spent = [];
  const threads = [];
  const send = async (input, init) => {
    sent.push({ url: String(input), init });
    return respond(String(input), init);
  };
  return { sent, spent, threads, gate: { blocked: async () => null, open: async () => ({ ok: true, fetch: send }), spent: async (cost) => void spent.push(cost), threadStarted: async (id) => void threads.push(id) } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const helperMocks = {
  "convex/decisions": { checkParameters: () => {} },
  "convex/diagnosis": { modelId: () => "gpt-5.4-mini" },
  "convex/learning/rules": {},
};
const VENDOR_ENV = { OPENAI_API_KEY: "sk-test-stand-in", SUPERMEMORY_API_KEY: "sm-stand-in", KEIKI_API_KEY: "k", KEIKI_AGENT_ID: "agent", KEIKI_OWNER_CONTACT: "+15550000000" };

test("with a no, no vendor helper sends anything, and each says why the way it says a key is missing", async (t) => {
  const helpers = createLoader(helperMocks);
  const global = [];
  t.mock.method(globalThis, "fetch", async (input) => (global.push(String(input)), json({})));
  const erased = [];
  const gate = deniedGate(async (input) => (erased.push(String(input)), json({})));
  await withEnv(VENDOR_ENV, async () => {
    const { callModel } = helpers("convex/routing/models.ts");
    const model = await callModel(gate, { ref: { provider: "openai", model: "gpt-5.4-mini" }, system: "s", user: "u", timeoutMs: 1000, maxOutputTokens: 10 });
    assert.deepEqual(model, { ok: false, infra: true, blocked: true, reason: REASON, durationMs: 0 });

    const { askJson } = helpers("convex/fixOptions.ts");
    assert.deepEqual(await askJson(gate, "system", { case: "x" }), { ok: false, reason: REASON });

    const { respond } = helpers("convex/codeNetwork/openai.ts");
    await assert.rejects(respond(gate, { instructions: "i", input: "code", maxOutputTokens: 10 }), (error) => error.name === "Refused" && error.message === REASON.charAt(0).toUpperCase() + REASON.slice(1) + ".");

    const voice = helpers("convex/voice/openai.ts");
    assert.deepEqual(await voice.transcribe(gate, new ArrayBuffer(4), "audio/webm", "hint"), { ok: false, reason: REASON });
    assert.deepEqual(await voice.speak(gate, "hello"), { ok: false, reason: REASON });

    const memory = helpers("convex/supermemory.ts");
    await assert.rejects(memory.searchChunks(gate, "app_1", "why"), { name: "Refused" });
    await assert.rejects(memory.searchMemories(gate, "app_1", "why"), { name: "Refused" });
    await assert.rejects(memory.searchWithMetadata(gate, "app_1", "why"), { name: "Refused" });
    await assert.rejects(memory.addMemory(gate, "app_1", "note", {}), { name: "Refused" });
    await assert.rejects(memory.putDocument(gate, "app_1", "id", "note", {}), { name: "Refused" });
    await assert.rejects(memory.addDocuments(gate, "code_1", [{ id: "a", content: "code", metadata: {} }]), { name: "Refused" });
    await memory.deleteDocuments(gate, "prefs_1", ["doc-1"]);
    assert.equal(erased.length, 1, "deleting the owner's copy still goes through the gate's fetch");

    const capy = helpers("convex/prTracking/capy.ts");
    const config = { ok: true, apiKey: "capy-key", projectId: "p1" };
    assert.deepEqual(await capy.startCapyThread(gate, config, { repo: "octo/app", requestId: "r1", title: "t", message: "m" }), { ok: false, message: REASON + "." });
    assert.deepEqual(await capy.findPullRequestNumber(gate, config, "thread-1", "octo/app"), { ok: false, message: `turtl stopped checking on Capy: ${REASON}.` });

    const keiki = helpers("convex/keiki.ts");
    assert.deepEqual(await keiki.sendOwnerNotice(gate, "A customer reported a problem with Booking."), { outcome: "not_configured" });
  });
  assert.deepEqual(global, [], "no helper called fetch itself");
});

test("with a yes, every helper sends through the gate's fetch only, and model calls report their cost", async (t) => {
  const helpers = createLoader(helperMocks);
  t.mock.method(globalThis, "fetch", async (input) => assert.fail(`a helper called fetch itself: ${input}`));
  const { gate, sent, spent, threads } = allowedGate((url) => {
    if (url.includes("/chat/completions")) return json({ choices: [{ message: { content: '{"cause":"x"}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    if (url.includes("/v1/responses")) return json({ output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 2000, output_tokens: 10 } });
    if (url.includes("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]));
    if (url.includes("/audio/transcriptions")) return json({ text: "what broke" });
    if (url.includes("supermemory")) return json({ results: [], total: 0, timing: 1 });
    if (url.includes("/threads")) return json({ id: "thread-9" });
    if (url.includes("onkeiki.com")) return json({ results: [{ outcome: "ran" }] });
    return json({});
  });
  await withEnv(VENDOR_ENV, async () => {
    const { callModel } = helpers("convex/routing/models.ts");
    assert.equal((await callModel(gate, { ref: { provider: "openai", model: "gpt-5.4-mini" }, system: "s", user: "u", timeoutMs: 5000, maxOutputTokens: 10 })).ok, true);
    assert.equal((await helpers("convex/fixOptions.ts").askJson(gate, "system", {})).ok, true);
    await helpers("convex/codeNetwork/openai.ts").respond(gate, { instructions: "i", input: "code", maxOutputTokens: 10 });
    const voice = helpers("convex/voice/openai.ts");
    assert.equal((await voice.transcribe(gate, new ArrayBuffer(4), "audio/webm", "hint")).ok, true);
    assert.equal((await voice.speak(gate, "hello")).ok, true);
    await helpers("convex/supermemory.ts").searchChunks(gate, "app_1", "why");
    assert.equal((await helpers("convex/prTracking/capy.ts").startCapyThread(gate, { ok: true, apiKey: "k", projectId: "p" }, { repo: "o/a", requestId: "turtl:r1", title: "t", message: "m" })).ok, true);
    assert.equal((await helpers("convex/keiki.ts").sendOwnerNotice(gate, "Booking needs you.")).outcome, "ran");
  });
  const hosts = sent.map(({ url }) => new URL(url).hostname);
  assert.deepEqual([...new Set(hosts)].sort(), ["api.capy.ai", "api.openai.com", "api.supermemory.ai", "onkeiki.com"]);
  const responses = sent.find(({ url }) => url.endsWith("/v1/responses"));
  assert.equal(JSON.parse(responses.init.body).store, false, "RC-28: the Responses API never keeps what turtl sends");
  assert.equal(spent.length, 5, "both chat calls, the Responses call and both voice calls are counted");
  assert.ok(spent.every((cost) => cost > 0));
  assert.deepEqual(threads, ["turtl:r1"]);
});

test("a vendor's error text never reaches the owner or the logs: only its status and error type", async (t) => {
  const helpers = createLoader(helperMocks);
  const echo = "the customer's card number is 4242 and the code says const password = 'hunter22'";
  const logged = [];
  t.mock.method(console, "error", (...args) => void logged.push(args.join(" ")));
  const { gate } = allowedGate(() => json({ error: { type: "invalid_request_error", message: `Bad request: ${echo}` } }, 400));
  await withEnv(VENDOR_ENV, async () => {
    const { respond } = helpers("convex/codeNetwork/openai.ts");
    await assert.rejects(respond(gate, { instructions: "i", input: echo, maxOutputTokens: 10 }), (error) => {
      assert.equal(error.message, "OpenAI answered with an error (status 400)");
      return true;
    });
    const memory = helpers("convex/supermemory.ts");
    await assert.rejects(memory.searchChunks(gate, "app_1", echo), (error) => {
      assert.equal(error.message, "Supermemory answered with an error (status 400)");
      return true;
    });
  });
  assert.ok(logged.some((line) => line === "OpenAI request failed: status 400, invalid_request_error"), logged.join("\n"));
  assert.ok(logged.some((line) => /^Supermemory request failed: status 400$/.test(line)), logged.join("\n"));
  assert.ok(logged.every((line) => !line.includes("hunter22") && !line.includes("4242")));
  assert.equal(outbound.plainFailure("OpenAI", new SyntaxError(`Unexpected token in ${echo}`)), "OpenAI's answer could not be read");
  assert.equal(outbound.plainFailure("OpenAI", new TypeError(echo)), "OpenAI's answer could not be used");
  assert.equal(outbound.plainFailure("Supermemory", Object.assign(new Error(echo), { statusCode: 502 })), "Supermemory answered with an error (status 502)");
});

test("the structural review records the refusal on the case and asks no model", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => assert.fail(`fetch called: ${input}`));
  const examine = createLoader()("convex/structural/examine.ts");
  const calls = [];
  const ctx = {
    runQuery: async (fn, args) => {
      calls.push(fn.path);
      if (fn.path === "internal.consent.gate.check") return { ok: false, reason: REASON };
      return { skip: null, prompt: { availableChecks: [] }, known: {}, relatedCaseIds: ["cases:2", "cases:3"], triggerSummary: "two related cases.", reason: "related_history", seededCaseCount: 0 };
    },
    runMutation: async (fn, args) => {
      if (fn.path === "internal.consent.gate.admit") return (calls.push(fn.path), { ok: false, reason: REASON });
      return (calls.push([fn.path, args.error ?? null]), "agentRuns:1");
    },
  };
  const input = { case: { _id: "cases:1", appId: "apps:1" }, step: { _id: "steps:1" }, attempt: { _id: "stepAttempts:1" } };
  const result = await withEnv({ ...ACCOUNTS, OPENAI_API_KEY: "sk-test-stand-in" }, () => examine.examineBroaderCauses(ctx, input));
  assert.equal(result.status, "done");
  assert.match(result.summary, new RegExp(`No model answered \\(${REASON.replace(/[()]/g, "\\$&")}\\), so no broader cause was recorded`));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "internal.structural.records.finishRun" && call[1] === `No model answered: ${REASON}.`));
});

// The test that fails when someone adds an outbound call without the question. A file may call fetch itself only if
// it is listed here as reaching a host that store/data-practices.json says needs no permission (GitHub, Revyl, the
// owner's own app). Everything else goes through gate.open(...), whose fetch is the only one that reaches a gated host.
const NO_PERMISSION_NEEDED = {
  "convex/consent/outbound.ts": "the gate's own fetch, handed out only after the check",
  "convex/push/expo.ts": "Expo's push service: the owner turns notifications on for each phone, and a push carries only the project's name, a fixed sentence and the case id",
  "convex/auth/email.ts": "the email service that sends a password-reset code the person asked for (it calls fetch through a parameter, so the scan below does not see it; listed so a reader does)",
  "convex/auth/appleTokens.ts": "Apple's token endpoints: Apple's own sign-in code and refresh token go back to Apple, to keep the token at sign-in and revoke it when the account is deleted",
  "convex/protectedApp/client.ts": "the owner's own app",
  "convex/revyl/api.ts": "Revyl",
  "convex/revyl/runs.ts": "Revyl's screenshots",
  "convex/prTracking/github.ts": "GitHub",
  "convex/github/api.ts": "GitHub",
  "convex/onboarding/github.ts": "GitHub",
  "convex/codeNetwork/build.ts": "GitHub (the repository is read; what leaves for OpenAI and Supermemory goes through the gate)",
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [relative(root, path).split("\\").join("/")] : [];
  });
}

test("every outbound call to a service that needs permission asks the gate first", () => {
  const gatedHosts = [
    ...practices.services.filter((service) => service.needsPermission).flatMap((service) => service.hosts),
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.supermemory.ai",
  ];
  const files = sourceFiles(join(root, "convex")).filter((file) => file !== "convex/codeNetwork/seed.ts");
  const problems = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    const bareFetch = /(?<![\w$.])fetch\s*\(/.test(code);
    const hosts = gatedHosts.filter((host) => code.includes(host));
    if (bareFetch && !(file in NO_PERMISSION_NEEDED)) {
      problems.push(`${file} calls fetch itself. Ask the gate first: take a Gate (convex/consent/gate.ts) and send with the fetch gate.open(service) returns. If the host needs no permission in store/data-practices.json, list the file in NO_PERMISSION_NEEDED with why.`);
    }
    if (hosts.length && !file.startsWith("convex/consent/")) {
      if (bareFetch) problems.push(`${file} names ${hosts.join(", ")} and calls fetch itself.`);
      if (!/gate\.open\(/.test(code)) problems.push(`${file} names ${hosts.join(", ")} but never asks gate.open(...).`);
    }
    if (/from\s+["']supermemory["']/.test(code) && file !== "convex/supermemory.ts") problems.push(`${file} uses the Supermemory SDK directly; use convex/supermemory.ts, which asks the gate.`);
  }
  const memory = readFileSync(join(root, "convex/supermemory.ts"), "utf8");
  const clients = [...memory.matchAll(/new Supermemory\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(clients.length > 0);
  for (const args of clients) if (!/fetch:\s*opened\.fetch/.test(args)) problems.push(`convex/supermemory.ts makes a client without the gate's fetch: new Supermemory(${args})`);
  for (const file of Object.keys(NO_PERMISSION_NEEDED)) assert.ok(files.includes(file), `${file} no longer exists; remove it from NO_PERMISSION_NEEDED`);
  assert.deepEqual(problems, []);
});

test("every caller hands the vendor helpers a gate for its own project", () => {
  // Each helper's first parameter is the gate, so a call without one does not compile; this checks each caller
  // builds that gate for a project, a case or an account.
  const files = sourceFiles(join(root, "convex"));
  const callers = files.filter((file) => /gateFor\(ctx, \{ (appId|caseId|account)\b/.test(readFileSync(join(root, file), "utf8")));
  for (const expected of [
    "convex/runner/handlers/investigate.ts", "convex/council/run.ts", "convex/runner/handlers/plan.ts", "convex/fixes.ts", "convex/learning/model.ts",
    "convex/intake/triage.ts", "convex/intake/workflow.ts", "convex/memory/service.ts", "convex/learning/preferences.ts", "convex/structural/examine.ts",
    "convex/codeNetwork/build.ts", "convex/codeNetwork/ask.ts", "convex/onboarding/inspect.ts", "convex/onboarding/prepare.ts", "convex/prTracking/execute.ts",
    "convex/pullRequests.ts", "convex/voice/turn.ts", "convex/notices.ts", "convex/keiki.ts",
  ]) assert.ok(callers.includes(expected), `${expected} does not build a gate for its project`);
});
