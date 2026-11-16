import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Tripwire for TUR-61: every public query, mutation and action under convex/ asks convex/access.ts who is calling,
// by calling one of its exports in its body or going through internal.access.*. A new public function without that
// check fails CI here. If a function truly needs no check, name it in ALLOWED with the reason, in plain words.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const convexDir = join(root, "convex");
const ACCESS = join(convexDir, "access.ts");
const GATED = join(convexDir, "functions");
const BUILDERS = new Set(["query", "mutation", "action"]);

// "convex/<file>.ts:<export>" -> why it needs no check. Empty today: every public function asks.
const ALLOWED = {};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const target = (file, specifier) => resolve(dirname(file), specifier).replace(/\.(ts|js)$/, "");

// Finds the public functions a file exports and whether each one's definition reaches convex/access.ts.
export function publicFunctions(file, text = readFileSync(file, "utf8")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const builders = new Map();
  const accessNames = new Set();
  const accessNamespaces = new Set();
  const internals = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
    const from = target(file, statement.moduleSpecifier.text);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && from === ACCESS.replace(/\.ts$/, "")) accessNamespaces.add(bindings.name.text);
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      const local = element.name.text;
      if (from === join(convexDir, "_generated", "server") && BUILDERS.has(imported)) builders.set(local, { kind: imported, gated: false });
      if (from === GATED && BUILDERS.has(imported)) builders.set(local, { kind: imported, gated: true });
      if (from === ACCESS.replace(/\.ts$/, "")) accessNames.add(local);
      if (from === join(convexDir, "_generated", "api") && imported === "internal") internals.add(local);
    }
  }
  const asks = (node) => {
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (ts.isIdentifier(child) && accessNames.has(child.text)) {
        const parent = child.parent;
        // A property named like an access export (obj.requireAccount) is not a call to it.
        if (!(ts.isPropertyAccessExpression(parent) && parent.name === child) && !(ts.isPropertyAssignment(parent) && parent.name === child)) found = true;
      }
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && accessNamespaces.has(child.expression.text)) found = true;
      if (
        ts.isPropertyAccessExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        child.expression.name.text === "access" &&
        ts.isIdentifier(child.expression.expression) &&
        internals.has(child.expression.expression.text)
      ) found = true;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const found = [];
  const record = (name, initializer) => {
    let call = initializer;
    while (call && (ts.isParenthesizedExpression(call) || ts.isAsExpression(call) || ts.isSatisfiesExpression(call))) call = call.expression;
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !builders.has(call.expression.text)) return;
    const { kind, gated } = builders.get(call.expression.text);
    found.push({ name, kind, gated, asks: asks(call) });
  };
  for (const statement of source.statements) {
    const exported = ts.getModifiers?.(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) record(declaration.name.text, declaration.initializer);
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) record("default", statement.expression);
  }
  return found;
}

const all = sourceFiles(convexDir).flatMap((file) =>
  publicFunctions(file).map((fn) => ({ ...fn, id: relative(root, file).split("\\").join("/") + ":" + fn.name })),
);

test("the scan finds every public function the plain pattern finds, and more than a handful", () => {
  const pattern = /^export const (\w+) = (query|mutation|action)\(/gm;
  const plain = sourceFiles(convexDir).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(pattern)].map((match) => relative(root, file).split("\\").join("/") + ":" + match[1]),
  );
  const ids = new Set(all.map((fn) => fn.id));
  assert.ok(all.length >= 70, `Only ${all.length} public functions found; the scan is probably broken.`);
  assert.deepEqual(plain.filter((id) => !ids.has(id)), []);
});

test("every public query, mutation and action asks convex/access.ts, or is allowed with a reason", () => {
  const unchecked = all.filter((fn) => !fn.asks && !(fn.id in ALLOWED)).map((fn) => `${fn.id} (${fn.kind})`);
  assert.deepEqual(
    unchecked,
    [],
    "These public functions do not ask convex/access.ts who is calling. Call a check from it at the top of the handler " +
      "(requireApp, requireCase, visibleApp, visibleCase, guardApp, guardCase, guardRow, canSeeApp, canSeeCase, " +
      "guardAppInAction, guardCaseInAction, requireDevTools, ...) or, if it truly needs none, add it to ALLOWED with the reason.",
  );
});

// Review finding 13: the builders in convex/functions.ts refuse every call when the deployment is the single-owner demo
// and holds accounts. A public function made with the builders in convex/_generated/server would skip that.
const RAW_BUILDERS = {
  // Its import line belongs to another branch tonight (GitHub permissions): switch it to ../functions once that merges.
  "convex/github/connect.ts": "every public function here asks currentAccount, requireAccount or internal.access.account first, and in the demo those refuse a deployment that holds accounts just as the builders do",
};

test("every public function is made with the builders in convex/functions.ts, which refuse a demo deployment that holds accounts", () => {
  const raw = all.filter((fn) => !fn.gated && !(fn.id.split(":")[0] in RAW_BUILDERS)).map((fn) => `${fn.id} (${fn.kind})`);
  assert.deepEqual(raw, [], 'Import query, mutation and action from "convex/functions.ts", not from "convex/_generated/server".');
  for (const [file, reason] of Object.entries(RAW_BUILDERS)) {
    assert.ok(all.some((fn) => fn.id.startsWith(file + ":") && !fn.gated), `${file} no longer needs its place in RAW_BUILDERS.`);
    assert.ok(reason.length >= 20);
  }
});

test("every allowance names a public function that still exists and says why", () => {
  for (const [id, reason] of Object.entries(ALLOWED)) {
    assert.ok(all.some((fn) => fn.id === id), `${id} is allowed but is no longer a public function. Remove it from ALLOWED.`);
    assert.ok(typeof reason === "string" && reason.trim().length >= 20, `${id} needs a written reason.`);
  }
});

test("the tripwire catches a public function without a check, and accepts each way of asking", () => {
  const file = join(convexDir, "example", "probe.ts");
  const scan = (body) => publicFunctions(file, [
    'import { v } from "convex/values";',
    'import { query as q, mutation, internalQuery } from "../_generated/server";',
    'import { action } from "../functions";',
    'import { internal } from "../_generated/api";',
    'import { canSeeApp, guardApp } from "../access";',
    'import * as access from "../access";',
    body,
  ].join("\n"));
  assert.deepEqual(scan('export const open = q({ args: {}, handler: async (ctx) => ctx.db.query("apps").take(1) });'), [{ name: "open", kind: "query", gated: false, asks: false }]);
  assert.deepEqual(scan('export const write = mutation({ args: {}, handler: async (ctx) => { const o = { guardApp: 1 }; return o.guardApp; } });'), [{ name: "write", kind: "mutation", gated: false, asks: false }]);
  assert.deepEqual(scan('export const hidden = internalQuery({ args: {}, handler: async () => null });'), [], "internal functions are not public");
  assert.equal(scan('export const read = q({ args: { id: v.string() }, handler: async (ctx, { id }) => (await canSeeApp(ctx, id)) ? 1 : null });')[0].asks, true);
  assert.equal(scan('export const write = mutation({ args: {}, handler: async (ctx) => { await access.requireAccount(ctx); } });')[0].asks, true);
  assert.equal(scan('export const act = action({ args: {}, handler: async (ctx) => await ctx.runQuery(internal.access.account, {}) });')[0].asks, true);
  assert.deepEqual(scan('export default mutation({ args: {}, handler: async () => null });'), [{ name: "default", kind: "mutation", gated: false, asks: false }]);
  assert.equal(scan('export const act = action({ args: {}, handler: async () => null });')[0].gated, true, "made with convex/functions.ts");
});
