import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { v } from "convex/values";

function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const catalog = load("./catalog.ts");
const provider = load("./provider.ts");
const internal = { bookingDemo: {
  state: { read: "state.read" },
  records: { saveBooking: "records.saveBooking", saveFailure: "records.saveFailure", readBooking: "records.readBooking", cleanup: "records.cleanup" },
} };
const define = (definition) => definition;
const selection = () => {
  const fixture = catalog.catalog();
  return { serviceId: fixture.services[0].id, date: fixture.date, time: fixture.slots[0] };
};

function setup(config, recommend = provider.recommend) {
  let providerCalls = 0;
  const imports = {
    "../_generated/api": { internal },
    "../_generated/server": { action: define, query: define, internalAction: define },
    "convex/values": { v },
    "./catalog": catalog,
    "./provider": { recommend: (...args) => { providerCalls += 1; return recommend(...args); } },
  };
  const core = load("./journeyCore.ts", imports);
  const booking = load("./booking.ts", { ...imports, "./journeyCore": core });
  const checks = load("./checks.ts", { ...imports, "./journeyCore": core });
  const bookings = new Map();
  const failures = [];
  const writes = [];
  const ctx = {
    runQuery: async (ref, args) => {
      if (ref === internal.bookingDemo.state.read) return config;
      assert.equal(ref, internal.bookingDemo.records.readBooking);
      return bookings.get(args.bookingId) ?? null;
    },
    runMutation: async (ref, args) => {
      if (ref === internal.bookingDemo.records.saveBooking) {
        writes.push(args);
        if (args.bookingStoreFailure) throw new Error("BOOKING_STORE_UNAVAILABLE");
        const id = `booking-${writes.length}`;
        bookings.set(id, args);
        return id;
      }
      if (ref === internal.bookingDemo.records.saveFailure) {
        failures.push(args);
        return `failure-${failures.length}`;
      }
      assert.equal(ref, internal.bookingDemo.records.cleanup);
      const fixtures = [...bookings].filter(([, row]) => row.fixtureRunId === args.fixtureRunId);
      for (const [id] of fixtures) bookings.delete(id);
      return fixtures.length;
    },
  };
  return { booking, checks, ctx, bookings, failures, writes, providerCalls: () => providerCalls };
}

for (const recommendationsEnabled of [true, false]) {
  for (const providerTimeout of [true, false]) {
    for (const bookingStoreFailure of [true, false]) {
      const config = { recommendationsEnabled, providerTimeout, bookingStoreFailure };
      test(`submit and journey preserve persistence and store failures: ${JSON.stringify(config)}`, async () => {
        const h = setup(config, () => { throw new Error("Submission must not call the provider"); });
        const input = selection();
        const result = await h.booking.submit.handler(h.ctx, input);
        assert.equal(result.ok, !bookingStoreFailure);
        assert.deepEqual(h.writes[0], { ...input, bookingStoreFailure });
        if (bookingStoreFailure) {
          assert.equal(result.error.code, "BOOKING_STORE_UNAVAILABLE");
          assert.equal(result.error.step, "submit_booking");
          assert.equal(h.failures.length, 1);
          assert.equal(h.bookings.size, 0);
        } else {
          assert.deepEqual(h.bookings.get(result.bookingId), { ...input, bookingStoreFailure });
          assert.equal(h.failures.length, 0);
        }

        const journey = await h.checks.journey.handler(h.ctx);
        assert.equal(journey.verdict, bookingStoreFailure ? "failed" : "passed");
        assert.equal(journey.failedStep, bookingStoreFailure ? "submit_booking" : null);
        assert.deepEqual(journey.configuration, config);
        assert.equal(journey.steps.find((step) => step.step === "recommendations").verdict, "skipped");
        assert.equal(journey.steps.find((step) => step.step === "submit_booking").verdict, bookingStoreFailure ? "failed" : "passed");
        assert.equal(journey.steps.find((step) => step.step === "verify_persisted").verdict, bookingStoreFailure ? "skipped" : "passed");
        assert.deepEqual(journey.cleanup, { ok: true, deletedBookings: bookingStoreFailure ? 0 : 1 });
        assert.equal(h.bookings.size, bookingStoreFailure ? 0 : 1);
        assert.equal(h.failures.length, bookingStoreFailure ? 1 : 0, "Fixtures must not record customer failures");
        assert.equal(h.providerCalls(), 0);
      });
    }
  }
}

test("recommendations remain an enhancement when the provider responds or fails", async () => {
  for (const fails of [false, true]) {
    const h = setup({ recommendationsEnabled: true, providerTimeout: false, bookingStoreFailure: false }, async () => {
      if (fails) throw new Error("PROVIDER_UNAVAILABLE");
      return ["unwind", "reset"];
    });
    const suggestions = h.booking.recommendations.handler(h.ctx);
    const result = await h.booking.submit.handler(h.ctx, selection());
    assert.equal(result.ok, true);
    assert.ok(h.bookings.has(result.bookingId));
    assert.deepEqual(await suggestions, fails ? { status: "unavailable", serviceIds: [] } : { status: "ready", serviceIds: ["unwind", "reset"] });
    assert.equal(h.providerCalls(), 1, "Only the independent recommendations action calls the provider");
    assert.equal(h.failures.length, 0);
  }
});

test("booking is persisted before the staged recommendation timeout", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup({ recommendationsEnabled: true, providerTimeout: true, bookingStoreFailure: false });
  const suggestions = h.booking.recommendations.handler(h.ctx);
  const result = await h.booking.submit.handler(h.ctx, selection());
  assert.equal(result.ok, true);
  assert.ok(h.bookings.has(result.bookingId));
  t.mock.timers.tick(provider.STAGED_TIMEOUT_MS);
  assert.deepEqual(await suggestions, { status: "unavailable", serviceIds: [] });
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.failures.length, 0);
});

test("a recommendation request that never settles cannot hold up submission", { timeout: 1000 }, async () => {
  const h = setup({ recommendationsEnabled: true, providerTimeout: true, bookingStoreFailure: false }, () => new Promise(() => {}));
  void h.booking.recommendations.handler(h.ctx);
  const result = await h.booking.submit.handler(h.ctx, selection());
  assert.equal(result.ok, true);
  assert.ok(h.bookings.has(result.bookingId));
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.failures.length, 0);
});

test("disabled recommendations never call the provider", async () => {
  const h = setup({ recommendationsEnabled: false, providerTimeout: true, bookingStoreFailure: false });
  assert.deepEqual(await h.booking.recommendations.handler(h.ctx), { status: "disabled", serviceIds: [] });
  assert.equal((await h.booking.submit.handler(h.ctx, selection())).ok, true);
  assert.equal(h.providerCalls(), 0);
});

test("invalid selections still fail without attempting persistence or recommendations", async () => {
  const h = setup({ recommendationsEnabled: true, providerTimeout: true, bookingStoreFailure: false });
  for (const invalid of [{ serviceId: "missing" }, { date: "2000-01-01" }, { time: "00:00" }]) {
    const result = await h.booking.submit.handler(h.ctx, { ...selection(), ...invalid });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_SELECTION");
    assert.equal(result.error.step, "submit_booking");
    assert.equal(result.error.retryable, false);
  }
  assert.equal(h.writes.length, 0);
  assert.equal(h.failures.length, 3);
  assert.equal(h.providerCalls(), 0);
});

test("unexpected persistence errors still propagate", async () => {
  const h = setup({ recommendationsEnabled: true, providerTimeout: true, bookingStoreFailure: false });
  const failure = new Error("Unexpected database failure");
  h.ctx.runMutation = async (ref) => {
    assert.equal(ref, internal.bookingDemo.records.saveBooking);
    throw failure;
  };
  await assert.rejects(h.booking.submit.handler(h.ctx, selection()), (error) => error === failure);
});
