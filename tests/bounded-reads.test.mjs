import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Tripwire for the security review's finding 4: one account's activity must not be able to make a read fail for
// every other account. Convex stops a function that reads too many documents, so a read whose size grows with the
// whole deployment is a lever anyone can pull: create enough projects, keys and reports and Stop fails for everyone.
//
// 1. Nothing reads the _scheduled_functions system table without an index bound (every account's jobs land there).
//    Cancel by the job ids kept on the row instead (convex/runner/jobs.ts).
// 2. No public query, mutation or action collect()s a table without an index that picks out one project, case or
//    account (an eq() in withIndex), outside the single-owner demo's own branch (AUTH_REQUIRED unset).
// A read that truly needs an exception is named in ALLOWED with the reason, in plain words.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const convexDir = join(root, "convex");
const BUILDERS = new Set(["query", "mutation", "action"]);

// "convex/<file>.ts:<line text>" -> why the read is allowed.
const ALLOWED = {
  "convex/dev.ts:_scheduled_functions": "dev tools only: requireDevTools refuses with AUTH_REQUIRED=true, so no account can reach it",
  "convex/memory/reset.ts:_scheduled_functions": "an internal booking-demo reset the operator runs from a terminal on a demo deployment with DEV_TOOLS_ENABLED",
  "convex/runner/jobs.ts:_scheduled_functions": "for attempts dispatched before job ids were kept: bounded by a 15-minute lookback and take(1000)",
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

// The calls in a chain like ctx.db.query("t").withIndex(...).order("desc").collect(), from the root outwards.
function chainOf(call) {
  const links = [];
  let node = call;
  while (node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      links.unshift({ name: node.expression.name.text, args: node.arguments, receiver: node.expression.expression });
      node = node.expression.expression;
    } else if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    else break;
  }
  return links;
}

const textOf = (node) => node.getText();
const isSystem = (link) => ts.isPropertyAccessExpression(link.receiver) && link.receiver.name.text === "system";

/** Every database read chain in a file: the table, its links, where it is, and the node of its last call. */
function readChains(source) {
  const found = [];
  const visit = (node) => {
    // The outermost call of a chain: its parent is not a property access continuing it.
    if (ts.isCallExpression(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
      const links = chainOf(node);
      const start = links.findIndex((link) => link.name === "query" && link.args.length === 1 && ts.isStringLiteral(link.args[0]));
      if (start !== -1 && /\bdb\b/.test(textOf(links[start].receiver))) {
        found.push({ table: links[start].args[0].text, system: isSystem(links[start]), links: links.slice(start + 1), node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const has = (chain, name) => chain.links.some((link) => link.name === name);
const index = (chain) => chain.links.find((link) => link.name === "withIndex");
const bounded = (chain) => ["take", "first", "unique", "paginate"].some((name) => has(chain, name));

// A _scheduled_functions read must be bounded by its index: a range that ends in take/first, or at least a lower
// bound on _creationTime (a lookback) before collect().
function scheduledProblem(chain) {
  const range = index(chain);
  if (!range) return "reads every job with no index bound";
  const callback = range.args[1] ? textOf(range.args[1]) : "";
  if (!/\.(eq|gt|gte)\(/.test(callback)) return "uses an index with no bound";
  if (!bounded(chain) && !/\.(gt|gte)\(/.test(callback)) return "collects without a lower bound";
  return null;
}

// Does this node run only in the single-owner demo? It does when it sits on the false side of accessEnforced() (or a
// name bound to it), on the true side of !accessEnforced(), or after `if (accessEnforced()) return ...`.
function demoOnly(node, boundNames) {
  const enforced = (expr) => {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "accessEnforced") return true;
    return ts.isIdentifier(expr) && boundNames.has(expr.text);
  };
  const negated = (expr) => ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken && enforced(expr.operand);
  const leaves = (statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || (ts.isBlock(statement) && statement.statements.some(leaves));
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenFalse && enforced(parent.condition)) return true;
      if (child === parent.whenTrue && negated(parent.condition)) return true;
    }
    if (ts.isIfStatement(parent)) {
      if (child === parent.elseStatement && enforced(parent.expression)) return true;
      if (child === parent.thenStatement && negated(parent.expression)) return true;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const before = parent.statements.slice(0, parent.statements.indexOf(child));
      if (before.some((statement) => ts.isIfStatement(statement) && !statement.elseStatement && enforced(statement.expression) && leaves(statement.thenStatement))) return true;
      // requireDevTools() throws with accounts on (convex/access.ts), so what follows it runs only in the demo.
      if (before.some((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && textOf(statement.expression.expression) === "requireDevTools")) return true;
    }
  }
  return false;
}

// The public functions a file exports: the builder call of each, from convex/functions.ts (which every public function
// uses) or from convex/_generated/server.
function publicDefinitions(file, source) {
  const builders = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const from = resolve(dirname(file), statement.moduleSpecifier.text);
    if (!from.endsWith(join("convex", "_generated", "server")) && from !== join(convexDir, "functions")) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if (BUILDERS.has((element.propertyName ?? element.name).text)) builders.add(element.name.text);
    }
  }
  const found = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !ts.getModifiers?.(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer;
      if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && builders.has(call.expression.text)) found.push({ name: declaration.name.getText(), call });
    }
  }
  return found;
}

const within = (node, outer) => node.pos >= outer.pos && node.end <= outer.end;

export function problemsIn(file, text = readFileSync(file, "utf8")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const id = relative(root, file).split("\\").join("/");
  const chains = readChains(source);
  const problems = [];
  for (const chain of chains) {
    if (chain.table !== "_scheduled_functions" || !chain.system) continue;
    const problem = scheduledProblem(chain);
    if (problem && !(`${id}:_scheduled_functions` in ALLOWED)) problems.push(`${id}: a _scheduled_functions read ${problem}`);
  }
  for (const definition of publicDefinitions(file, source)) {
    const boundNames = new Set();
    const collectNames = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && /^accessEnforced\(\)$/.test(textOf(node.initializer))) boundNames.add(node.name.text);
      ts.forEachChild(node, collectNames);
    };
    collectNames(definition.call);
    for (const chain of chains) {
      if (!within(chain.node, definition.call) || !has(chain, "collect")) continue;
      const range = index(chain);
      const scoped = range && range.args[1] && /\.eq\(/.test(textOf(range.args[1]));
      if (scoped || demoOnly(chain.node, boundNames)) continue;
      const key = `${id}:${definition.name}:${chain.table}`;
      if (!(key in ALLOWED)) problems.push(`${key}: collect() over ${chain.table} ${range ? "through an index with no eq()" : "with no index"} in a public function`);
    }
  }
  return [...new Set(problems)];
}

test("no read of the scheduled jobs or of a whole shared table can be made to fail by another account's activity", () => {
  const problems = sourceFiles(convexDir).flatMap((file) => problemsIn(file));
  assert.deepEqual(
    problems,
    [],
    "Bound these reads: cancel scheduled jobs by the ids kept on the row (convex/runner/jobs.ts), and read a table " +
      "through an index that picks one project, case or account (withIndex(..., q => q.eq(...))) with take(n). " +
      "If a read truly needs neither, add it to ALLOWED in this file with the reason.",
  );
});

test("the scan sees every public function, whichever module its builder comes from", () => {
  const pattern = /^export const (\w+) = (query|mutation|action)\(/gm;
  for (const file of sourceFiles(convexDir)) {
    const text = readFileSync(file, "utf8");
    const seen = publicDefinitions(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)).map((definition) => definition.name);
    for (const [, name] of text.matchAll(pattern)) assert.ok(seen.includes(name), `${relative(root, file)}:${name} is not seen`);
  }
});

test("every allowance still names a read that exists, and says why", () => {
  for (const [key, reason] of Object.entries(ALLOWED)) {
    const [file, ...rest] = key.split(":");
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const chains = readChains(source);
    const exists = rest.length === 1
      ? chains.some((chain) => chain.system && chain.table === "_scheduled_functions")
      : publicDefinitions(join(root, file), source).some((definition) => definition.name === rest[0]) && chains.some((chain) => chain.table === rest[1]);
    assert.ok(exists, `${key} is allowed but no longer exists. Remove it from ALLOWED.`);
    assert.ok(reason.length >= 30, `${key} needs a written reason`);
  }
});

test("the tripwire catches each shape it is for, and lets the bounded and demo-only reads through", () => {
  const file = join(convexDir, "example", "probe.ts");
  const scan = (body) => problemsIn(file, [
    'import { v } from "convex/values";',
    'import { query, mutation, internalMutation } from "../_generated/server";',
    'import { accessEnforced } from "../access";',
    body,
  ].join("\n"));
  // The scheduled jobs table.
  assert.equal(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.system.query("_scheduled_functions").collect(); } });').length, 1, "the whole table");
  assert.equal(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time").collect(); } });').length, 1, "an index with no bound");
  assert.deepEqual(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", (q) => q.gt("_creationTime", Date.now() - 1000)).take(10); } });'), []);
  // A shared table in a public function.
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => (await ctx.db.query("recoveryMemories").collect()).length });'), ["convex/example/probe.ts:a:recoveryMemories: collect() over recoveryMemories with no index in a public function"]);
  assert.equal(scan('export const a = mutation({ args: {}, handler: async (ctx) => await ctx.db.query("pullRequests").withIndex("by_settled").collect() });').length, 1, "an index that picks nothing out");
  assert.deepEqual(scan('export const a = query({ args: { id: v.id("apps") }, handler: async (ctx, { id }) => await ctx.db.query("journeys").withIndex("by_app", (q) => q.eq("appId", id)).collect() });'), []);
  assert.deepEqual(scan('export const a = internalMutation({ args: {}, handler: async (ctx) => await ctx.db.query("apps").collect() });'), [], "internal functions are not public");
  // The demo's own branch.
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => accessEnforced() ? [] : await ctx.db.query("cases").collect() });'), []);
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => { const accounts = accessEnforced(); return accounts ? [] : await ctx.db.query("cases").collect(); } });'), []);
  assert.deepEqual(scan('export const a = query({ args: {}, handler: async (ctx) => { if (accessEnforced()) return []; return await ctx.db.query("cases").collect(); } });'), []);
  assert.equal(scan('export const a = query({ args: {}, handler: async (ctx) => accessEnforced() ? await ctx.db.query("cases").collect() : [] });').length, 1, "the accounts side is checked");
  assert.deepEqual(scan('export const a = mutation({ args: {}, handler: async (ctx) => { requireDevTools(); return await ctx.db.query("cases").collect(); } });'), [], "dev tools are closed with accounts on");
});
