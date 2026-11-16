import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLoader } from "./fixtures/convex-memory.mjs";

// The theme the person chose is kept across launches and reloads, in the storage the session already uses, and read
// before the first frame. Someone who never chose gets dark.

function storage(platform, secure = new Map()) {
  return createLoader({
    "react-native": { Platform: { OS: platform } },
    "expo-secure-store": { getItem: (key) => secure.get(key) ?? null, setItem: (key, value) => secure.set(key, value) },
  })("theme/storage.ts");
}
const memory = (initial = null, { failing = false } = {}) => {
  let value = initial;
  return {
    read: () => { if (failing) throw new Error("no storage"); return value; },
    write: (next) => { if (failing) throw new Error("no storage"); value = next; },
    get value() { return value; },
  };
};

test("a choice is kept and read back; nothing kept, or something unreadable, means the default", () => {
  const { readMode, writeMode } = storage("web");
  const store = memory();
  assert.equal(readMode(store), null);
  writeMode("light", store);
  assert.equal(store.value, "light");
  assert.equal(readMode(store), "light");
  assert.equal(readMode(memory("purple")), null);
  assert.equal(readMode(memory(null, { failing: true })), null, "a store that cannot be read is not an error");
  assert.doesNotThrow(() => writeMode("dark", memory(null, { failing: true })));
});

test("on the phone the choice goes to the Keychain through expo-secure-store, read synchronously", () => {
  const secure = new Map();
  const { readMode, writeMode } = storage("ios", secure);
  assert.equal(readMode(), null);
  writeMode("light");
  assert.equal(secure.get("turtl.theme"), "light");
  assert.equal(readMode(), "light");
});

test("in the browser it goes to localStorage", () => {
  const kept = new Map();
  globalThis.localStorage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  try {
    const { readMode, writeMode } = storage("web");
    writeMode("light");
    assert.equal(kept.get("turtl.theme"), "light");
    assert.equal(readMode(), "light");
  } finally {
    delete globalThis.localStorage;
  }
});

test("the provider starts from the kept choice, dark by default, and keeps every change", () => {
  const source = readFileSync(new URL("../theme/index.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<ThemeMode>\(\(\) => readMode\(\) \?\? "dark"\)/);
  assert.match(source, /setChosen\(next\);\n    writeMode\(next\);/);
  assert.doesNotMatch(source, /useColorScheme/, "the phone's own setting is not followed");
});
