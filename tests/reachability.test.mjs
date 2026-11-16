import assert from "node:assert/strict";
import { test } from "node:test";
import { UNREACHABLE_AFTER_MS, watchReachability } from "../data/live/reachability.ts";

function harness(t, connected = false) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const listeners = new Set();
  const seen = [];
  const client = {
    connected,
    connectionState: () => ({ isWebSocketConnected: client.connected }),
    subscribeToConnectionState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const stop = watchReachability(client, (reachable) => seen.push(reachable));
  return {
    seen,
    stop,
    listeners,
    set: (value) => { client.connected = value; listeners.forEach((listener) => listener()); },
    retry: () => listeners.forEach((listener) => listener()),
    pass: (ms) => t.mock.timers.tick(ms),
  };
}

test("a connection that opens in time is never reported", (t) => {
  const h = harness(t);
  h.pass(UNREACHABLE_AFTER_MS - 1);
  h.set(true);
  h.pass(UNREACHABLE_AFTER_MS * 3);
  assert.deepEqual(h.seen, []);
});

test("a backend that stays unreachable is reported once, however often the client retries", (t) => {
  const h = harness(t);
  for (let waited = 0; waited < UNREACHABLE_AFTER_MS - 500; waited += 500) {
    h.pass(500);
    h.retry();
  }
  assert.deepEqual(h.seen, []);
  h.pass(500);
  assert.deepEqual(h.seen, [false]);
  h.retry();
  h.pass(UNREACHABLE_AFTER_MS * 2);
  assert.deepEqual(h.seen, [false]);
});

test("reconnecting clears the report, and a later drop waits the full time again", (t) => {
  const h = harness(t, true);
  h.set(false);
  h.pass(UNREACHABLE_AFTER_MS);
  h.set(true);
  assert.deepEqual(h.seen, [false, true]);
  h.set(false);
  h.pass(UNREACHABLE_AFTER_MS - 1);
  assert.deepEqual(h.seen, [false, true]);
  h.pass(1);
  assert.deepEqual(h.seen, [false, true, false]);
});

test("time spent suspended in the background does not count as unreachable", (t) => {
  const h = harness(t);
  t.mock.timers.setTime(10 * 60_000);
  t.mock.timers.tick(UNREACHABLE_AFTER_MS);
  assert.deepEqual(h.seen, [], "the timer fired late, so the wait starts again");
  h.pass(UNREACHABLE_AFTER_MS);
  assert.deepEqual(h.seen, [false]);
});

test("stopping removes the listener and the pending timer", (t) => {
  const h = harness(t);
  h.stop();
  assert.equal(h.listeners.size, 0);
  h.pass(UNREACHABLE_AFTER_MS * 2);
  assert.deepEqual(h.seen, []);
});
