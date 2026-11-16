import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Tripwire for TUR-61: every public query, mutation and action under convex/ asks convex/access.ts who is calling,
// by calling one of its checks in its body or going through an internal.access query that checks. A new public
// function without that fails CI here. Mentioning accessEnforced, a constant or any other export that checks nobody
// does not count (review, "Coverage tripwire"). If a function truly needs no check, name it in ALLOWED with the reason,
// in plain words. The cross-account test in tests/access-rules.test.mjs then calls each function that takes an id as
// one account with another account's ids.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const convexDir = join(root, "convex");
const ACCESS = join(convexDir, "access.ts");
const GATED = join(convexDir, "functions");
const BUILDERS = new Set(["query", "mutation", "action"]);

// The exports of convex/access.ts that check who is calling, or that a row is theirs. Calling one counts.
const CHECKS = new Set([
  "requireAccount", "currentAccount", "signedInAccount",
  "requireApp", "requireCase", "visibleApp", "visibleCase", "visibleApps", "visibleCases",
  "guardApp", "guardCase", "guardRow", "canSeeApp", "canSeeCase", "guardAppInAction", "guardCaseInAction",
  // Not identity, but it refuses whenever accounts are on, so the function can reach no account's records.
  "requireDevTools",
  // Who is calling, for the "check your email" screen only: the signed-in account while its address is unconfirmed, and
  // null for everyone else (signed out, confirmed, or the demo). signedInAccount reads that account as signed out.
  "pendingAccount",
]);
// The internal.access queries an action calls instead, each of which runs one of the checks above.
const CHECKING_QUERIES = new Set(["account", "app", "caseAccess", "appGuard", "caseGuard", "pending"]);
// Every other export of convex/access.ts, which checks nobody: a switch, a constant, a predicate on a row already
// loaded, or the demo's own gate (convex/functions.ts runs that for every function). A new export must join one list.
const NOT_CHECKS = new Set([
  "SOLO_ACCOUNT", "SIGN_IN_REQUIRED", "NOT_AVAILABLE", "DEV_TOOLS_DISABLED", "BOOKING_DEMO_CLOSED", "UNAVAILABLE", "NO_SIGN_IN",
  "MAX_PROJECTS", "MAX_CASES_PER_PROJECT", "accessEnforced", "ownsApp", "ownerActor", "projectCases", "devToolsEnabled",
  "hostsBookingDemo", "requireBookingDemo", "refuseDemoWithAccounts", "refuseDemoWithAccountsInAction", "refuseSignInToDemo",
  "account", "app", "caseAccess", "appGuard", "caseGuard", "demoOpen", "pending",
  // Facts about a session, asked after a check has said who is calling (convex/push/devices.ts).
  "sessionLive", "callerSession",
]);

// "convex/<file>.ts:<export>" -> why it needs no check: the public functions that are open by design.
const ALLOWED = {
  // Answers before anyone signs in, so the app knows whether to show sign-in at all. It reads no account's records.
  "convex/users.ts:mode": "says whether this backend runs accounts and which sign-in methods are set up, before anyone signs in, and reads no account's records",
  // The single-owner demo's shared passcode. With accounts on, status returns a constant and set refuses.
  "convex/ownerPasscode.ts:status": "says whether the single-owner demo has an owner passcode; with accounts on it returns a constant",
  "convex/ownerPasscode.ts:set": "sets the single-owner demo's passcode, behind the current passcode; with accounts on it refuses before reading anything",
  // The dev tools switch, which the app reads to hide its dev controls.
  "convex/dev.ts:status": "says whether dev tools are open on this deployment, which they never are with accounts on, and reads no account's records",
  // The booking demo is a stand-in for an owner's live app: its customers book without any turtl account. With
  // accounts on, requireBookingDemo closes these unless the deployment hosts the booking demo (convex/access.ts).
  "convex/bookingDemo/booking.ts:getCatalog": "the booking demo's customer API takes no turtl account by design, and requireBookingDemo closes it on a deployment that does not host the demo",
  "convex/bookingDemo/booking.ts:getFlags": "the booking demo's customer API takes no turtl account by design, and requireBookingDemo closes it on a deployment that does not host the demo",
  "convex/bookingDemo/booking.ts:recommendations": "the booking demo's customer API takes no turtl account by design, and requireBookingDemo closes it on a deployment that does not host the demo",
  "convex/bookingDemo/booking.ts:submit": "the booking demo's customer API takes no turtl account by design, and requireBookingDemo closes it on a deployment that does not host the demo",
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const target = (file, specifier) => resolve(dirname(file), specifier).replace(/\.(ts|js)$/, "");

// Finds the public functions a file exports and whether each one's definition calls a check in convex/access.ts.
export function publicFunctions(file, text = readFileSync(file, "utf8")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const builders = new Map();
  const checks = new Set();
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
      if (from === ACCESS.replace(/\.ts$/, "") && CHECKS.has(imported)) checks.add(local);
      if (from === join(convexDir, "_generated", "api") && imported === "internal") internals.add(local);
    }
  }
  const asks = (node) => {
    let found = false;
    const visit = (child) => {
      if (found) return;
      // A call to a check: check(...) or access.check(...).
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        if (ts.isIdentifier(callee) && checks.has(callee.text)) found = true;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && accessNamespaces.has(callee.expression.text) && CHECKS.has(callee.name.text)) found = true;
      }
      // An internal.access query that checks, handed to ctx.runQuery.
      if (
        ts.isPropertyAccessExpression(child) &&
        CHECKING_QUERIES.has(child.name.text) &&
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
// No file needs the raw builders today. A file listed here must say why its public functions are covered without them.
const RAW_BUILDERS = {};

test("every public function is made with the builders in convex/functions.ts, which refuse a demo deployment that holds accounts", () => {
  const raw = all.filter((fn) => !fn.gated && !(fn.id.split(":")[0] in RAW_BUILDERS)).map((fn) => `${fn.id} (${fn.kind})`);
  assert.deepEqual(raw, [], 'Import query, mutation and action from "convex/functions.ts", not from "convex/_generated/server".');
  for (const [file, reason] of Object.entries(RAW_BUILDERS)) {
    assert.ok(all.some((fn) => fn.id.startsWith(file + ":") && !fn.gated), `${file} no longer needs its place in RAW_BUILDERS.`);
    assert.ok(reason.length >= 20);
  }
});

test("every allowance names a public function that still exists, needs it, and says why", () => {
  for (const [id, reason] of Object.entries(ALLOWED)) {
    const fn = all.find((candidate) => candidate.id === id);
    assert.ok(fn, `${id} is allowed but is no longer a public function. Remove it from ALLOWED.`);
    assert.equal(fn.asks, false, `${id} now calls a check. Remove it from ALLOWED.`);
    assert.ok(typeof reason === "string" && reason.trim().length >= 20, `${id} needs a written reason.`);
  }
});

test("every export of convex/access.ts is named either a check or not one", () => {
  const source = ts.createSourceFile(ACCESS, readFileSync(ACCESS, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = source.statements.flatMap((statement) => {
    if (!ts.getModifiers?.(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isFunctionDeclaration(statement)) return [statement.name.text];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((declaration) => declaration.name.getText(source));
    return [];
  });
  assert.deepEqual(exported.filter((name) => !CHECKS.has(name) && !NOT_CHECKS.has(name)), [], "Add each new export of convex/access.ts to CHECKS or NOT_CHECKS here.");
  assert.deepEqual([...CHECKS, ...NOT_CHECKS].filter((name) => !exported.includes(name)), [], "These are no longer exports of convex/access.ts.");
  assert.deepEqual([...CHECKING_QUERIES].filter((name) => !exported.includes(name)), []);
});

test("the tripwire catches a public function without a check, and accepts each way of asking", () => {
  const file = join(convexDir, "example", "probe.ts");
  const scan = (body) => publicFunctions(file, [
    'import { v } from "convex/values";',
    'import { query as q, mutation, internalQuery } from "../_generated/server";',
    'import { action } from "../functions";',
    'import { internal } from "../_generated/api";',
    'import { accessEnforced, canSeeApp, guardApp, NOT_AVAILABLE, ownsApp } from "../access";',
    'import * as access from "../access";',
    body,
  ].join("\n"));
  // Mentioning an export that checks nobody, or naming a check without calling it, is not asking.
  assert.equal(scan('export const a = q({ args: {}, handler: async (ctx) => accessEnforced() ? null : await ctx.db.query("apps").take(1) });')[0].asks, false, "accessEnforced");
  assert.equal(scan('export const a = q({ args: {}, handler: async (ctx) => { if (!ctx) throw new Error(NOT_AVAILABLE); return await ctx.db.query("apps").take(1); } });')[0].asks, false, "a constant");
  assert.equal(scan('export const a = q({ args: {}, handler: async (ctx) => (await ctx.db.query("apps").take(1)).filter((app) => ownsApp(app, "x")) });')[0].asks, false, "a predicate with an account from nowhere");
  assert.equal(scan('export const a = q({ args: {}, handler: async (ctx) => { const check = guardApp; return await ctx.db.query("apps").take(1); } });')[0].asks, false, "a check named, not called");
  assert.equal(scan('export const a = q({ args: {}, handler: async (ctx) => access.accessEnforced() });')[0].asks, false, "access.accessEnforced");
  assert.equal(scan('export const a = action({ args: {}, handler: async (ctx) => await ctx.runQuery(internal.access.demoOpen, {}) });')[0].asks, false, "the demo's gate is not identity");
  assert.deepEqual(scan('export const open = q({ args: {}, handler: async (ctx) => ctx.db.query("apps").take(1) });'), [{ name: "open", kind: "query", gated: false, asks: false }]);
  assert.deepEqual(scan('export const write = mutation({ args: {}, handler: async (ctx) => { const o = { guardApp: 1 }; return o.guardApp; } });'), [{ name: "write", kind: "mutation", gated: false, asks: false }]);
  assert.deepEqual(scan('export const hidden = internalQuery({ args: {}, handler: async () => null });'), [], "internal functions are not public");
  assert.equal(scan('export const read = q({ args: { id: v.string() }, handler: async (ctx, { id }) => (await canSeeApp(ctx, id)) ? 1 : null });')[0].asks, true);
  assert.equal(scan('export const write = mutation({ args: {}, handler: async (ctx) => { await access.requireAccount(ctx); } });')[0].asks, true);
  assert.equal(scan('export const act = action({ args: {}, handler: async (ctx) => await ctx.runQuery(internal.access.account, {}) });')[0].asks, true);
  assert.deepEqual(scan('export default mutation({ args: {}, handler: async () => null });'), [{ name: "default", kind: "mutation", gated: false, asks: false }]);
  assert.equal(scan('export const act = action({ args: {}, handler: async () => null });')[0].gated, true, "made with convex/functions.ts");
});
