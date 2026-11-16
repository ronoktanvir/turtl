import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// Review finding 18. Signing out ran every sign-out listener, but nothing registered one, so the phone stayed filed
// under the old account: its project names and "A case needs your decision" kept arriving, and the next account to
// sign in on that phone was refused ("This phone still gets notifications for another turtl account").
//
// These load the app's real data/account and data/push modules, with the Convex client, the sign-in library, the
// phone and its storage replaced by stand-ins, and sign out the way the account screen does.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const TOKEN = "ExponentPushToken[phone]";
const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });

function phone({ stored = { token: TOKEN, offered: true } } = {}) {
  const calls = [];
  const memory = { value: structuredClone(stored) };
  const watchers = new Set();
  let connected = true;
  // The backend answers each mutation as `answer` says: "ok", "refuse" (a ConvexError), or "hang" (never, until
  // the connection returns, as the Convex client keeps a mutation queued while it is offline).
  let answer = "ok";
  const queued = [];
  const client = {
    connectionState: () => ({ isWebSocketConnected: connected }),
    subscribeToConnectionState: (listener) => (watchers.add(listener), () => watchers.delete(listener)),
    mutation: async (fn, args) => {
      calls.push([fn.path, args]);
      if (answer === "refuse") throw Object.assign(new Error("Sign in to continue."), { data: "Sign in to continue." });
      if (answer === "hang") await new Promise((resolve) => queued.push(resolve));
      return null;
    },
  };
  const mocks = {
    react: { useMemo: (factory) => factory(), useSyncExternalStore: () => undefined, useEffect: () => {}, useState: (value) => [value, () => {}] },
    "react-native": { Platform: { OS: "ios" } },
    "convex/react": { useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }), useQuery: () => undefined },
    "@convex-dev/auth/react": { useAuthActions: () => ({ signIn: async () => {}, signOut: async () => void calls.push("session ended") }) },
    "expo-apple-authentication": {},
    "expo-crypto": {},
    "expo-linking": {},
    "expo-web-browser": {},
    "convex/_generated/api": { api: ref("api"), internal: ref("internal") },
    "data/live/client": { liveClient: client, requireLiveClient: () => client, errorMessage: (error) => error?.data ?? error?.message },
    "data/source": { isLiveData: true, isStoreBuild: true },
    "data/push/memory": { readPushMemory: async () => structuredClone(memory.value), writePushMemory: async (value) => void (memory.value = structuredClone(value)) },
    "data/push/device": { pushDevice: () => ({ supported: true, platform: "ios", permission: async () => "granted", onTokenChange: () => () => {}, onOpen: () => () => {} }) },
  };
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
      const key = resolve(dirname(file), name).slice(root.length + 1);
      if (key in mocks) return mocks[key];
      for (const candidate of [key + ".ts", key + "/index.ts"]) {
        try {
          readFileSync(resolve(root, candidate));
          return load(resolve(root, candidate));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      throw new Error("Cannot load " + key);
    };
    runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: file })(require, module.exports, module);
    return module.exports;
  };
  // The app loads both at start: the account actions, and data/push through the notifications row in the layout.
  const account = load(resolve(root, "data/account/index.ts"));
  load(resolve(root, "data/push/index.ts"));
  return {
    actions: account.useAccountActions(),
    calls,
    memory,
    answer: (value) => void (answer = value),
    disconnect: () => {
      connected = false;
      for (const listener of watchers) listener({ isWebSocketConnected: false });
    },
    reconnect: () => {
      connected = true;
      for (const resume of queued.splice(0)) resume();
    },
  };
}

const removal = ["api.push.devices.remove", { token: TOKEN }];

test("ATTACK (finding 18): signing out removes this phone's notifications from the backend before the session ends", async () => {
  const p = phone();
  assert.equal(await p.actions.signOut(), null);
  assert.deepEqual(p.calls, [removal, "session ended"], "the old account's notifications stop, and the next account can register this phone");
  assert.deepEqual(p.memory.value, { offered: true }, "the phone forgets the token");
});

test("a phone that never turned notifications on signs out without asking the backend anything", async () => {
  const p = phone({ stored: { offered: true } });
  assert.equal(await p.actions.signOut(), null);
  assert.deepEqual(p.calls, ["session ended"]);
});

test("if the connection drops while the removal waits, sign-out stops and says so; the session and the phone's token stay, and trying again works", async () => {
  const p = phone();
  p.answer("hang");
  const first = p.actions.signOut();
  await new Promise((resolve) => setImmediate(resolve));
  p.disconnect();
  assert.equal(await first, "You're offline. Connect to the internet and try again.");
  assert.deepEqual(p.calls, [removal], "the session was not ended with the phone still registered");
  assert.equal(p.memory.value.token, TOKEN);
  // The connection returns: the queued removal goes through under the session it belongs to, and sign-out works.
  p.answer("ok");
  p.reconnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.memory.value, { offered: true });
  assert.equal(await p.actions.signOut(), null);
  assert.deepEqual(p.calls, [removal, "session ended"]);
});

test("a backend that refuses the removal (the session had already ended) still lets the phone sign out and forget the token", async () => {
  const p = phone();
  p.answer("refuse");
  assert.equal(await p.actions.signOut(), null);
  assert.deepEqual(p.calls, [removal, "session ended"]);
  assert.deepEqual(p.memory.value, { offered: true });
});
