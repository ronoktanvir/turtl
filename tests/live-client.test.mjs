import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

function clientHooks({ live = true, url = "https://local-test.convex.cloud" } = {}) {
  const slots = [];
  const effects = new Set();
  const watches = new Map();
  const timers = new Map();
  const calls = [];
  let cursor = 0;
  let timerId = 0;
  let notifications = 0;
  let statusUnsubscribe;
  const same = (left, right) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));
  const watchFor = (ref, args) => {
    const key = JSON.stringify([ref, args]);
    if (!watches.has(key)) watches.set(key, { value: undefined, error: null, callbacks: new Set() });
    return watches.get(key);
  };
  class ConvexReactClient {
    constructor(clientUrl, options) { calls.push({ kind: "construct", url: clientUrl, options }); }
    watchQuery(ref, args) {
      calls.push({ kind: "watch", ref, args });
      const state = watchFor(ref, args);
      return {
        localQueryResult: () => {
          if (state.error) throw state.error;
          return state.value;
        },
        onUpdate: (callback) => {
          state.callbacks.add(callback);
          return () => state.callbacks.delete(callback);
        },
      };
    }
  }
  const imports = {
    "convex/react": { ConvexReactClient },
    "convex/server": { getFunctionName: (ref) => ref },
    "../source": { isLiveData: live },
    react: {
      useMemo: (factory, deps) => {
        const index = cursor++;
        if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
        return slots[index].value;
      },
      useState: (initial) => {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
        return [slots[index].value, (value) => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }];
      },
      useEffect: (effect, deps) => {
        const index = cursor++;
        if (slots[index] && same(slots[index].deps, deps)) return;
        slots[index] = { ...slots[index], deps, effect };
        effects.add(index);
      },
      useSyncExternalStore: (subscribe, getSnapshot) => {
        if (!statusUnsubscribe) statusUnsubscribe = subscribe(() => { notifications += 1; });
        return getSnapshot();
      },
    },
  };
  const source = readFileSync(new URL("../data/live/client.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module, process, setTimeout, clearTimeout) { ${outputText}\n})`, { filename: "data/live/client.ts" })(
    (name) => {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
    module.exports,
    module,
    { env: { EXPO_PUBLIC_CONVEX_URL: url } },
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    (id) => timers.delete(id),
  );
  const client = module.exports;
  const unmount = () => {
    for (const slot of slots) {
      slot?.cleanup?.();
      if (slot) slot.cleanup = undefined;
    }
    statusUnsubscribe?.();
    statusUnsubscribe = undefined;
  };
  return {
    ...client,
    calls,
    watches,
    timers,
    unmount,
    notifications: () => notifications,
    status: () => client.useDataStatus(),
    query: (ref, args) => {
      cursor = 0;
      const result = client.useLiveQuery(ref, args);
      for (const index of effects) {
        slots[index].cleanup?.();
        slots[index].cleanup = slots[index].effect();
      }
      effects.clear();
      return result;
    },
    value: (ref, args, value) => { Object.assign(watchFor(ref, args), { value, error: null }); },
    fail: (ref, args, error) => { watchFor(ref, args).error = error; },
    emit: (ref, args) => { watchFor(ref, args).callbacks.forEach((callback) => callback()); },
    expire: () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test("useLiveQuery exposes loading and only the actual subscribed result", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  const ref = "screens/projects:list";
  assert.deepEqual(h.status(), { errors: [], loading: false });
  assert.equal(h.query(ref, {}), undefined);
  assert.deepEqual(h.status(), { errors: [], loading: true });
  assert.equal(h.query(ref, {}), undefined);
  const result = [{ app: { _id: "registered-app", name: "Actual registered app" } }];
  h.value(ref, {}, result);
  h.emit(ref, {});
  assert.equal(h.query(ref, {}), result);
  assert.deepEqual(h.status(), { errors: [], loading: false });
  assert.equal(h.calls.filter((call) => call.kind === "watch").length, 1);
  assert.ok(h.notifications() > 0);
});

test("a missing function thrown by localQueryResult is caught and exposed readably", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  const ref = "screens/network:resolve";
  const args = { projectId: "app-1" };
  h.fail(ref, args, new Error("[CONVEX Q(screens/network:resolve)] [Request ID: synthetic-id] Server Error\nCould not find public function screens/network:resolve"));
  assert.doesNotThrow(() => assert.equal(h.query(ref, args), undefined));
  assert.equal(h.query(ref, args), undefined);
  assert.deepEqual(h.status(), {
    loading: false,
    errors: ["screens/network:resolve: This backend has not been updated for this control yet. No example data was substituted."],
  });
  h.expire();
  assert.match(h.status().errors[0], /backend has not been updated/);
});

test("a failed update clears previously loaded data and a successful retry clears its error", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  const ref = "fixes:messages";
  const args = { caseId: "case-1" };
  const first = [{ id: "message-1", text: "A stored answer" }];
  h.value(ref, args, first);
  h.query(ref, args);
  assert.equal(h.query(ref, args), first);
  h.fail(ref, args, new Error("[CONVEX Q(fixes:messages)] Server Error\nUncaught Error: This case is unavailable.\n    at handler (fixes.ts:20)"));
  assert.doesNotThrow(() => h.emit(ref, args));
  assert.equal(h.query(ref, args), undefined);
  assert.deepEqual(h.status(), { loading: false, errors: ["fixes:messages: This case is unavailable."] });
  const next = [{ id: "message-2", text: "A later stored answer" }];
  h.value(ref, args, next);
  h.emit(ref, args);
  assert.equal(h.query(ref, args), next);
  assert.deepEqual(h.status(), { loading: false, errors: [] });
});

test("null and empty backend values are completed queries, not loading or example content", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  const ref = "codeNetwork/network:get";
  const args = { projectId: "app-1" };
  h.value(ref, args, null);
  h.query(ref, args);
  assert.equal(h.query(ref, args), null);
  assert.deepEqual(h.status(), { errors: [], loading: false });
  h.value(ref, args, []);
  h.emit(ref, args);
  assert.deepEqual(h.query(ref, args), []);
  assert.deepEqual(h.status(), { errors: [], loading: false });
});

test("changing query arguments cannot show the previous project's cached result", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  const ref = "codeNetwork/network:get";
  const firstArgs = { projectId: "app-1" };
  const nextArgs = { projectId: "app-2" };
  h.value(ref, firstArgs, { projectId: "app-1", nodes: ["first-project-only"] });
  h.query(ref, firstArgs);
  assert.equal(h.query(ref, firstArgs).projectId, "app-1");
  assert.equal(h.query(ref, nextArgs), undefined);
  assert.equal(h.query(ref, nextArgs), undefined);
  assert.deepEqual(h.status(), { errors: [], loading: true });
  assert.equal(h.watches.get(JSON.stringify([ref, firstArgs])).callbacks.size, 0);
  assert.equal(h.timers.size, 1);
});

test("a stalled query shows a readable timeout while its subscription can still recover", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  const ref = "cases:cards";
  const args = { id: "case-1" };
  h.query(ref, args);
  assert.equal([...h.timers.values()][0].delay, 15000);
  h.expire();
  assert.equal(h.query(ref, args), undefined);
  assert.deepEqual(h.status(), {
    loading: false,
    errors: ["The backend is taking longer than expected. Check your connection; this view will update when it reconnects."],
  });
  const recovered = { case: { _id: "case-1" } };
  h.value(ref, args, recovered);
  h.emit(ref, args);
  assert.equal(h.query(ref, args), recovered);
  assert.deepEqual(h.status(), { errors: [], loading: false });
});

test("skip and unmount remove subscriptions, timers, and stale query status", () => {
  const h = clientHooks();
  const ref = "fixes:messages";
  const args = { caseId: "case-1" };
  h.fail(ref, args, new Error("Could not find public function fixes:messages"));
  h.query(ref, args);
  assert.equal(h.status().errors.length, 1);
  assert.equal(h.query(ref, "skip"), undefined);
  assert.deepEqual(h.status(), { errors: [], loading: false });
  assert.equal(h.timers.size, 0);
  assert.equal(h.watches.get(JSON.stringify([ref, args])).callbacks.size, 0);
  h.query(ref, args);
  h.unmount();
  assert.deepEqual(h.status(), { errors: [], loading: false });
  assert.equal(h.timers.size, 0);
  assert.equal(h.watches.get(JSON.stringify([ref, args])).callbacks.size, 0);
  h.unmount();
});

test("example mode and a missing URL never open a backend watch or substitute data", (t) => {
  for (const options of [{ live: false }, { url: "" }]) {
    const h = clientHooks(options);
    t.after(h.unmount);
    assert.equal(h.query("screens/projects:list", {}), undefined);
    assert.deepEqual(h.status(), { errors: [], loading: false });
    assert.equal(h.calls.filter((call) => call.kind === "watch").length, 0);
    if ("url" in options) assert.throws(h.requireLiveClient, /backend URL is not configured/);
  }
});

test("the example build opens no backend connection even when a backend address is set", (t) => {
  const example = clientHooks({ live: false });
  t.after(example.unmount);
  assert.equal(example.liveClient, null);
  assert.equal(example.calls.filter((call) => call.kind === "construct").length, 0, "no client, so no socket and no console errors");
  const live = clientHooks({ live: true });
  t.after(live.unmount);
  assert.notEqual(live.liveClient, null);
  assert.equal(live.calls.filter((call) => call.kind === "construct").length, 1);
});

test("errorMessage removes Convex wrappers and stacks without hiding the actual refusal", (t) => {
  const h = clientHooks();
  t.after(h.unmount);
  for (const message of ["Could not find function decisions:stop", "Function decisions:stop not found", "client.mutation is not a function"]) {
    assert.equal(h.errorMessage(new Error(message)), "This backend has not been updated for this control yet. No example data was substituted.");
  }
  assert.equal(h.errorMessage(new Error("[CONVEX M(decisions:approve)] [Request ID: synthetic-id] Server Error\nUncaught ConvexError: A decision was already made.\n    at handler (decisions.ts:10)")), "A decision was already made.");
  assert.equal(h.errorMessage("Connection lost."), "Connection lost.");
  assert.equal(h.errorMessage(new Error("")), "The backend could not complete this request. Try again.");
});
