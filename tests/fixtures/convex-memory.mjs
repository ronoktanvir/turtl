import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// Loads backend modules without a server, the way tests/github-app.test.mjs does: relative imports follow the real
// files, convex/_generated is a stand-in, and any repository path can be replaced with a mock. Also an in-memory
// database that answers only through the indexes a schema declares.

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeRequire = createRequire(import.meta.url);

export const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
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
    httpAction: (handler) => handler,
  },
};

/** mocks: { "convex/supermemory": {...} } by repository path without extension. */
export function createLoader(mocks = {}) {
  const loaded = new Map();
  const load = (file) => {
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
    });
    const require = (name) => {
      if (!name.startsWith(".")) return name in mocks ? mocks[name] : nodeRequire(name);
      const target = resolve(dirname(file), name);
      const key = target.slice(root.length + 1).replace(/\.(ts|tsx)$/, "");
      if (key in mocks) return mocks[key];
      if (key in generated) return generated[key];
      if (target.endsWith(".json")) return load(target);
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        try {
          readFileSync(target + extension);
          return load(target + extension);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      throw new Error("Cannot resolve " + name + " from " + file);
    };
    runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: file })(require, module.exports, module);
    return module.exports;
  };
  return (path) => load(resolve(root, path));
}

/**
 * An in-memory copy of some tables. `tables` maps a table name to its defineTable(...) (for its indexes), or to null
 * for a table read only by id. Rows are checked against nothing else; reads must name a declared index, in order.
 */
export function memoryDb(tables, seed = {}) {
  // Convex Auth's accounts table is always there, empty unless seeded: in the single-owner demo every public function
  // first checks that it is (convex/access.ts, refuseDemoWithAccounts).
  const rows = new Map(Object.keys({ authAccounts: null, ...tables }).map((name) => [name, structuredClone(seed[name] ?? [])]));
  let counter = 1000;
  let clock = 0;
  for (const list of rows.values()) for (const row of list) row._creationTime ??= ++clock;
  const rowsOf = (table) => {
    assert.ok(rows.has(table), "Unknown table " + table);
    return rows.get(table);
  };
  const locate = (id) => {
    for (const [, list] of rows) {
      const index = list.findIndex((row) => row._id === id);
      if (index !== -1) return { list, index };
    }
    return null;
  };
  const reads = [];
  const db = {
    reads,
    rows: (table) => structuredClone(rowsOf(table)),
    /** Every table as it is now, for restore(): Convex undoes every write of a mutation that throws, and a test can too. */
    snapshot: () => new Map([...rows].map(([name, list]) => [name, structuredClone(list)])),
    restore: (saved) => {
      for (const [name, list] of saved) rows.set(name, structuredClone(list));
    },
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
    get: async (id) => {
      reads.push(["get", id]);
      const found = locate(id);
      return found ? structuredClone(found.list[found.index]) : null;
    },
    insert: async (table, fields) => {
      const row = { _id: table + ":" + ++counter, _creationTime: ++clock, ...structuredClone(fields) };
      rowsOf(table).push(row);
      return row._id;
    },
    patch: async (id, fields) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      found.list[found.index] = { ...found.list[found.index], ...structuredClone(fields) };
    },
    delete: async (id) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      found.list.splice(found.index, 1);
    },
    query: (table) => ({
      // A read of at most one row in creation order, as ctx.db.query(table).first() is in Convex.
      first: async () => {
        reads.push(["first", table]);
        return structuredClone(rowsOf(table).toSorted((a, b) => a._creationTime - b._creationTime)[0] ?? null);
      },
      withIndex: (name, build) => {
        reads.push(["index", table, name]);
        const fields = tables[table]?.export().indexes.find((index) => index.indexDescriptor === name)?.fields;
        assert.ok(fields, table + " has no index " + name);
        const conditions = [];
        // eq on the leading fields, then at most a range (lt, lte, gt, gte) on the next one, as Convex allows.
        const tests = { eq: (a, b) => a === b, lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b };
        const range = Object.fromEntries(Object.entries(tests).map(([operator, holds]) => [operator, (field, value) => (conditions.push([field, value, holds, operator]), range)]));
        build(range);
        let position = 0;
        for (const [field, , , operator] of conditions) {
          assert.equal(field, fields[position], table + "." + name + " cannot be read by " + field + " here");
          if (operator === "eq") position++;
        }
        let descending = false;
        const matched = () => {
          const list = rowsOf(table)
            .filter((row) => conditions.every(([field, value, holds]) => holds(row[field], value)))
            .sort((a, b) => a._creationTime - b._creationTime);
          return structuredClone(descending ? list.reverse() : list);
        };
        const cursor = {
          order: (direction) => ((descending = direction === "desc"), cursor),
          first: async () => matched()[0] ?? null,
          take: async (count) => matched().slice(0, count),
          collect: async () => assert.fail("An unbounded collect on " + table),
          unique: async () => {
            const list = matched();
            assert.ok(list.length <= 1, table + "." + name + ": unique() matched " + list.length + " rows");
            return list[0] ?? null;
          },
        };
        return cursor;
      },
    }),
  };
  return db;
}

/** Runs `work` with these variables set (undefined deletes one), then puts the environment back. */
export async function withEnv(env, work) {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
