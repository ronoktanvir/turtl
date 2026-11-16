import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// The app's side of accounts mode: when the backend's ownerPasscode.status says accounts, owner decisions run with
// no passcode and no prompt, and the passcode settings do not render. In the demo both behave as before.

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

function owner(status, stored) {
  const reads = [];
  const api = load("../data/live/ownerPasscode.ts", {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    "react-native": { Platform: { OS: "ios" } },
    "expo-secure-store": {
      getItemAsync: async () => { reads.push("read"); return stored ?? null; },
      setItemAsync: async () => {},
      deleteItemAsync: async () => {},
    },
    "../../convex/_generated/api": { api: { ownerPasscode: { status: "ownerPasscode:status" } } },
    "./client": { errorMessage: (error) => error.data ?? error.message, requireLiveClient: () => ({ query: async () => status }) },
  });
  return { ...api, reads };
}

test("with accounts on, an owner decision runs at once with no passcode, even if one is stored", async () => {
  const o = owner({ configured: false, accounts: true }, "old-fixture-passcode");
  const seen = [];
  assert.equal(await o.withOwnerPasscode(async (passcode) => { seen.push(passcode); return "approved"; }), "approved");
  assert.deepEqual(seen, [undefined]);
  assert.deepEqual(o.reads, [], "the stored passcode is not even read");
  assert.equal(o.useOwnerPasscodePrompt(), null);
  // A refusal from the backend is the backend's, not a passcode problem: it is passed on and no prompt opens.
  await assert.rejects(o.withOwnerPasscode(async () => { throw { data: "That project is not available on this account." }; }), (error) => error.data === "That project is not available on this account.");
  assert.equal(o.useOwnerPasscodePrompt(), null);
});

test("in the demo a configured passcode is still asked for", async () => {
  const o = owner({ configured: true });
  let ran = false;
  const decision = o.withOwnerPasscode(async () => { ran = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  assert.deepEqual(o.useOwnerPasscodePrompt(), { busy: false, error: undefined });
  o.cancelOwnerPasscode();
  await assert.rejects(decision, /cancelled/);
});

function settings(status, { storeBuild = false } = {}) {
  const { default: OwnerPasscodeSettings } = load("../components/project/OwnerPasscodeSettings.tsx", {
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" },
    react: { useState: (initial) => [initial, () => {}] },
    "react-native": { TextInput: "TextInput", View: "View" },
    "../../convex/_generated/api": { api: { ownerPasscode: { status: "ownerPasscode:status", set: "ownerPasscode:set" } } },
    "../../data/live/client": { errorMessage: (error) => error.message, requireLiveClient: () => ({}), useLiveQuery: () => status },
    "../../data/live/ownerPasscode": { storeOwnerPasscode: async () => {} },
    "../../data/source": { isStoreBuild: storeBuild },
    "../../theme": { useTheme: () => ({ colors: {} }) },
    "../ui": { Button: "Button", T: "T" },
  });
  return OwnerPasscodeSettings();
}

test("the passcode settings do not render with accounts on, nor in a store build while the answer loads", () => {
  assert.equal(settings({ configured: false, accounts: true }), null);
  assert.equal(settings(undefined, { storeBuild: true }), null);
  assert.equal(settings({ configured: false, accounts: true }, { storeBuild: true }), null);
});

test("in the demo the passcode settings render as before, loading included", () => {
  for (const status of [undefined, { configured: false }, { configured: true }]) {
    const view = settings(status);
    assert.equal(view?.type, "View");
    assert.equal(view.props.testID, "owner-passcode-settings");
  }
});
