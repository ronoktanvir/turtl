import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// The whole backend in memory, as tests/project-secrets.test.mjs builds it: real modules from convex/ (relative imports
// follow the real files, convex/_generated is a stand-in, any repository path can be mocked), every table in
// convex/schema.ts, reads only through the indexes the schema declares and in their order (a missing value sorts
// first, as in Convex), writes only of the fields it names, and a scheduler that records what was scheduled and when.

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeRequire = createRequire(import.meta.url);
const esModules = { "@convex-dev/auth/server": await import("@convex-dev/auth/server") };

const ref = (path) => new Proxy({ path }, { get: (target, key) => (key === "path" ? target.path : ref(path + "." + String(key))) });
const registered = (kind, visibility) => (definition) => ({ kind, visibility, ...definition });
const generated = {
  "convex/_generated/api": { api: ref("api"), internal: ref("internal"), components: ref("components") },
  "convex/_generated/server": {
    query: registered("query", "public"),
    mutation: registered("mutation", "public"),
    action: registered("action", "public"),
    internalQuery: registered("query", "internal"),
    internalMutation: registered("mutation", "internal"),
    internalAction: registered("action", "internal"),
    httpAction: (handler) => handler,
  },
};

/** mocks: { "convex/consent/gate": {...} } by repository path without extension. */
export function createLoader(mocks = {}) {
  const loaded = new Map();
  const load = (file) => {
    if (loaded.has(file)) return loaded.get(file).exports;
    const module = { exports: {} };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const require = (name) => {
      if (!name.startsWith(".")) return name in esModules ? esModules[name] : nodeRequire(name);
      const key = resolve(dirname(file), name).slice(root.length + 1);
      if (key in mocks) return mocks[key];
      if (key in generated) return generated[key];
      if (key.endsWith(".json")) {
        const data = JSON.parse(readFileSync(resolve(root, key), "utf8"));
        return { ...data, default: data };
      }
      return load(resolve(root, key + ".ts"));
    };
    runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: file })(require, module.exports, module);
    return module.exports;
  };
  return (path) => load(resolve(root, path));
}

const compare = (a, b) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : a < b ? -1 : 1);
const operators = { eq: (a, b) => a === b, gt: (a, b) => compare(a, b) > 0, gte: (a, b) => compare(a, b) >= 0, lt: (a, b) => compare(a, b) < 0, lte: (a, b) => compare(a, b) <= 0 };

export function createBackend(load) {
  const schema = load("convex/schema.ts").default.tables;
  const tables = new Map(Object.keys(schema).map((name) => [name, []]));
  const scheduled = [];
  const reads = [];
  let counter = 0;
  const rowsOf = (table) => {
    assert.ok(tables.has(table), "Unknown table " + table);
    return tables.get(table);
  };
  const locate = (id) => {
    const table = String(id).split(":")[0];
    const rows = tables.get(table) ?? [];
    const index = rows.findIndex((row) => row._id === id);
    return index === -1 ? null : { table, rows, index };
  };
  const checked = (table, fields) => {
    for (const name of Object.keys(fields)) assert.ok(name in schema[table].validator.fields, table + " has no field " + name);
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  };
  const indexFields = (table, name) => {
    if (name === "by_creation_time") return ["_creationTime"];
    const fields = schema[table].export().indexes.find((index) => index.indexDescriptor === name)?.fields;
    assert.ok(fields, table + " has no index " + name);
    return fields;
  };
  const builder = (table, index, conditions, order) => {
    // Each read is recorded as [table, index, documents it returned], which is what Convex counts against a function.
    const run = (limit = Infinity) => {
      const fields = index ? indexFields(table, index) : [];
      const rows = rowsOf(table)
        .filter((row) => conditions.every(([operator, field, value]) => operators[operator](row[field], value)))
        .sort((a, b) => fields.reduce((found, field) => found || compare(a[field], b[field]), 0) || a._creationTime - b._creationTime);
      const taken = (order === "desc" ? rows.reverse() : rows).slice(0, limit);
      reads.push([table, index, taken.length]);
      return structuredClone(taken);
    };
    return {
      withIndex: (name, build) => {
        const fields = indexFields(table, name);
        const found = [];
        const range = Object.fromEntries(Object.keys(operators).map((operator) => [operator, (field, value) => (found.push([operator, field, value]), range)]));
        build?.(range);
        // eq on the leading fields, then a range (one bound or two) on the next one, as Convex allows.
        let position = 0;
        for (const [operator, field] of found) {
          assert.equal(field, fields[position], table + "." + name + " cannot be read by " + field + " here");
          if (operator === "eq") position++;
        }
        return builder(table, name, found, order);
      },
      order: (direction) => builder(table, index, conditions, direction),
      collect: async () => run(),
      take: async (count) => run(count),
      first: async () => run(1)[0] ?? null,
      unique: async () => {
        const rows = run(2);
        assert.ok(rows.length <= 1, table + ": unique() matched " + rows.length + " rows");
        return rows[0] ?? null;
      },
    };
  };
  const db = {
    normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
    get: async (id) => {
      const found = locate(id);
      reads.push([String(id).split(":")[0], "get", found ? 1 : 0]);
      return found ? structuredClone(found.rows[found.index]) : null;
    },
    insert: async (table, fields) => {
      const row = { _id: table + ":" + ++counter, _creationTime: 1_800_000_000_000 + counter, ...checked(table, structuredClone(fields)) };
      rowsOf(table).push(row);
      return row._id;
    },
    patch: async (id, fields) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      const next = { ...found.rows[found.index], ...structuredClone(fields) };
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete next[key];
      checked(found.table, Object.fromEntries(Object.entries(next).filter(([key]) => !key.startsWith("_"))));
      found.rows[found.index] = next;
    },
    delete: async (id) => {
      const found = locate(id);
      assert.ok(found, "No document " + id);
      found.rows.splice(found.index, 1);
    },
    query: (table) => builder(table, null, [], "asc"),
    system: { query: () => ({ withIndex: () => ({ collect: async () => [] }) }) },
  };
  const scheduler = {
    runAfter: async (delay, fn, args) => void scheduled.push({ path: fn.path, args: structuredClone(args), at: Date.now() + delay }),
    cancel: async () => {},
  };
  const auth = (caller) => ({ getUserIdentity: async () => (caller ? { subject: caller + "|session-1", tokenIdentifier: "https://auth.test|" + caller } : null) });
  async function run(path, args = {}, caller = null) {
    const segments = path.split(".").slice(1);
    const name = segments.pop();
    const fn = load("convex/" + segments.join("/") + ".ts")[name];
    assert.ok(fn?.handler, "No function " + path);
    assert.equal(fn.visibility, path.startsWith("api.") ? "public" : "internal", path + " is " + fn.visibility);
    const ctx = fn.kind === "action" ? actionCtx(caller) : { db, scheduler, auth: auth(caller) };
    return structuredClone((await fn.handler(ctx, structuredClone(args))) ?? null);
  }
  const actionCtx = (caller) => ({
    auth: auth(caller),
    scheduler,
    runQuery: (fn, args) => run(fn.path, args, caller),
    runMutation: (fn, args) => run(fn.path, args, caller),
    runAction: (fn, args) => run(fn.path, args, caller),
  });
  return {
    db,
    run,
    actionCtx,
    scheduled,
    reads,
    rows: (table) => structuredClone(rowsOf(table)),
    /**
     * Runs what was scheduled under these paths whose time has come, as Convex would after the mutation commits, and
     * anything they schedule in turn. `runs(job)` false leaves a job scheduled but never run (a check that hangs).
     * Jobs under other paths are dropped. Returns the jobs it ran.
     */
    async drain(paths, runs = () => true) {
      const ran = [];
      const later = [];
      while (scheduled.length) {
        const job = scheduled.shift();
        if (!paths.includes(job.path)) continue;
        if (job.at > Date.now() || !runs(job)) {
          later.push(job);
          continue;
        }
        ran.push(job);
        await run(job.path, job.args);
      }
      scheduled.push(...later);
      return ran;
    },
  };
}
