import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// The booking demo's journey check and its scenarios, run against an in-memory copy of the booking tables.
// convex/bookingDemo/control.test.mjs runs the same contract over HTTP against a local deployment.

const nodeRequire = createRequire(import.meta.url);

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const ref = (path) => new Proxy({}, { get: (_target, key) => (key === "path" ? path : ref(`${path}.${String(key)}`)) });
const internal = ref("internal");
const server = { internalAction: (definition) => definition };
const catalog = load("../convex/bookingDemo/catalog.ts", {});
const provider = load("../convex/bookingDemo/provider.ts", {});
const core = load("../convex/bookingDemo/journeyCore.ts", { "../_generated/api": { internal }, "./catalog": catalog, "./provider": provider });
const { journey } = load("../convex/bookingDemo/checks.ts", {
  "convex/values": nodeRequire("convex/values"),
  "../_generated/server": server,
  "../_generated/api": { internal },
  "./catalog": catalog,
  "./journeyCore": core,
});

// The booking tables, and every call the journey makes into them.
function booking(settings) {
  const bookings = new Map();
  const attempts = [];
  const calls = [];
  let next = 0;
  const handlers = {
    "internal.bookingDemo.state.read": () => ({ ...settings, updatedAt: 1 }),
    "internal.bookingDemo.records.readBooking": ({ bookingId }) => bookings.get(bookingId) ?? null,
    "internal.bookingDemo.records.saveBooking": ({ bookingStoreFailure, ...row }) => {
      if (bookingStoreFailure) throw new Error("BOOKING_STORE_UNAVAILABLE");
      const id = `booking-${++next}`;
      bookings.set(id, row);
      return id;
    },
    "internal.bookingDemo.records.saveFailure": (row) => { attempts.push(row); return `attempt-${attempts.length}`; },
    "internal.bookingDemo.records.cleanup": ({ fixtureRunId }) => {
      const mine = [...bookings].filter(([, row]) => row.fixtureRunId === fixtureRunId);
      for (const [id] of mine) bookings.delete(id);
      return mine.length;
    },
  };
  const run = async (fn, args) => {
    calls.push(fn.path);
    assert.ok(fn.path in handlers, `Unexpected call: ${fn.path}`);
    return handlers[fn.path](args);
  };
  return { ctx: { runQuery: run, runMutation: run }, bookings, attempts, calls };
}

const live = { recommendationsEnabled: true, providerTimeout: false, bookingStoreFailure: false };

test("a journey check without a scenario answers exactly as before", async () => {
  const b = booking(live);
  const result = await journey.handler(b.ctx, {});
  assert.equal(result.verdict, "passed");
  assert.equal("scenario" in result, false);
  assert.deepEqual(result.configuration, live);
  assert.equal(b.bookings.size, 0);
});

test("slow_recommendations fails while booking waits for the provider, and says which scenario ran", async () => {
  const b = booking(live);
  const result = await journey.handler(b.ctx, { scenario: "slow_recommendations" });
  assert.equal(result.scenario, "slow_recommendations");
  assert.equal(result.verdict, "failed");
  assert.equal(result.failedStep, "recommendations");
  assert.equal(result.error.code, "RECOMMENDATIONS_TIMEOUT");
  assert.match(result.steps.find((s) => s.step === "recommendations").detail, /For this run only/);
  assert.deepEqual(result.configuration, live, "configuration reports the live settings, not the scenario's");
  assert.equal(b.attempts.length, 0, "a scenario's failure is never customer impact");
  assert.ok(!b.calls.some((path) => path.startsWith("internal.bookingDemo.state.set")), "a scenario never writes the settings");
  assert.equal(b.bookings.size, 0);
});

test("slow_recommendations passes once recommendations are off, and leaves no booking behind", async () => {
  const b = booking({ ...live, recommendationsEnabled: false });
  const result = await journey.handler(b.ctx, { scenario: "slow_recommendations" });
  assert.equal(result.verdict, "passed");
  assert.equal(result.scenario, "slow_recommendations");
  assert.equal(result.cleanup.deletedBookings, 1);
  assert.equal(b.bookings.size, 0);
  assert.equal(b.attempts.length, 0);
});

test("the journey check reads ?scenario= and refuses an unknown, empty or repeated one", () => {
  const read = (query) => core.readScenario(new URL(`https://x.convex.site/booking-demo/journey-check${query}`));
  assert.deepEqual(read(""), { ok: true, scenario: null });
  assert.deepEqual(read("?other=1"), { ok: true, scenario: null });
  assert.deepEqual(read("?scenario=slow_recommendations"), { ok: true, scenario: "slow_recommendations" });
  for (const query of ["?scenario=", "?scenario=unknown", "?scenario=toString", "?scenario=slow_recommendations&scenario=slow_recommendations"]) {
    const refused = read(query);
    assert.equal(refused.ok, false, query);
    assert.match(refused.message, /slow_recommendations/);
  }
});

test("every scenario turtl can offer is one the booking demo runs", () => {
  const rules = load("../convex/structural/rules.ts", {});
  assert.deepEqual(Object.keys(rules.CHECK_SCENARIOS).sort(), Object.keys(core.JOURNEY_SCENARIOS).sort());
});
